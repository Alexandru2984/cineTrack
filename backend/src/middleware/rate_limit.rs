use actix_web::body::{EitherBody, MessageBody};
use actix_web::dev::{Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::{http::header, Error, HttpResponse};
use futures_util::future::{ready, LocalBoxFuture, Ready};
use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::rc::Rc;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedProxyIpKeyExtractor;

impl TrustedProxyIpKeyExtractor {
    fn extract(&self, req: &ServiceRequest) -> Option<IpAddr> {
        let peer_ip = req.peer_addr().map(|socket| socket.ip())?;

        if is_trusted_proxy_peer(peer_ip) {
            if let Some(forwarded_ip) = forwarded_for_ip(req) {
                return Some(forwarded_ip);
            }
        }

        Some(peer_ip)
    }
}

#[derive(Clone)]
pub struct RateLimitConfig {
    limiter: Arc<DefaultKeyedRateLimiter<IpAddr>>,
    checks: Arc<AtomicU64>,
}

impl RateLimitConfig {
    pub fn new(requests_per_second: u32, burst_size: u32) -> Result<Self, &'static str> {
        let rate = NonZeroU32::new(requests_per_second)
            .ok_or("requests per second must be greater than zero")?;
        let burst = NonZeroU32::new(burst_size).ok_or("burst size must be greater than zero")?;
        let quota = Quota::per_second(rate).allow_burst(burst);

        Ok(Self {
            limiter: Arc::new(RateLimiter::keyed(quota)),
            checks: Arc::new(AtomicU64::new(0)),
        })
    }

    fn check(&self, key: &IpAddr) -> bool {
        // Keyed limiters retain one entry per client. Periodic eviction keeps
        // spoofed or short-lived addresses from turning that map into an
        // unbounded memory sink while preserving active buckets.
        if self
            .checks
            .fetch_add(1, Ordering::Relaxed)
            .is_multiple_of(1024)
        {
            self.limiter.retain_recent();
        }
        self.limiter.check_key(key).is_ok()
    }
}

#[derive(Clone)]
pub struct RateLimit {
    config: RateLimitConfig,
    extractor: TrustedProxyIpKeyExtractor,
}

impl RateLimit {
    pub fn new(config: &RateLimitConfig) -> Self {
        Self {
            config: config.clone(),
            extractor: TrustedProxyIpKeyExtractor,
        }
    }
}

pub struct RateLimitMiddleware<S> {
    service: Rc<S>,
    config: RateLimitConfig,
    extractor: TrustedProxyIpKeyExtractor,
}

impl<S, B> Transform<S, ServiceRequest> for RateLimit
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type InitError = ();
    type Transform = RateLimitMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(RateLimitMiddleware {
            service: Rc::new(service),
            config: self.config.clone(),
            extractor: self.extractor,
        }))
    }
}

impl<S, B> Service<ServiceRequest> for RateLimitMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    fn poll_ready(&self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.service.poll_ready(context)
    }

    fn call(&self, request: ServiceRequest) -> Self::Future {
        let service = Rc::clone(&self.service);
        let key = self.extractor.extract(&request);
        let allowed = key
            .as_ref()
            .is_some_and(|client_ip| self.config.check(client_ip));

        Box::pin(async move {
            if key.is_none() {
                let response = HttpResponse::InternalServerError().finish();
                return Ok(request.into_response(response).map_into_right_body());
            }
            if !allowed {
                let response = HttpResponse::TooManyRequests()
                    .insert_header((header::RETRY_AFTER, "1"))
                    .finish();
                return Ok(request.into_response(response).map_into_right_body());
            }

            service
                .call(request)
                .await
                .map(ServiceResponse::map_into_left_body)
        })
    }
}

fn forwarded_for_ip(req: &ServiceRequest) -> Option<IpAddr> {
    req.headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .and_then(parse_ip)
}

/// Resolve the real client IP for a plain `HttpRequest` (used outside the
/// rate-limiter, e.g. for session metadata). Honors `X-Forwarded-For` only when
/// the immediate peer is a trusted loopback/private proxy, mirroring the
/// extractor above.
pub fn client_ip(req: &actix_web::HttpRequest) -> Option<IpAddr> {
    let peer_ip = req.peer_addr().map(|socket| socket.ip())?;

    if is_trusted_proxy_peer(peer_ip) {
        if let Some(forwarded) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .and_then(parse_ip)
        {
            return Some(forwarded);
        }
    }

    Some(peer_ip)
}

fn parse_ip(value: &str) -> Option<IpAddr> {
    IpAddr::from_str(value)
        .ok()
        .or_else(|| SocketAddr::from_str(value).ok().map(|socket| socket.ip()))
}

fn is_trusted_proxy_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
        IpAddr::V6(ip) => ip.is_loopback() || ((ip.segments()[0] & 0xfe00) == 0xfc00),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test as actix_test, web, App};

    #[test]
    fn rejects_zero_rate_or_burst() {
        assert!(RateLimitConfig::new(0, 1).is_err());
        assert!(RateLimitConfig::new(1, 0).is_err());
    }

    #[actix_web::test]
    async fn rejects_exhausted_buckets_with_retry_after() {
        let config = RateLimitConfig::new(1, 1).unwrap();
        let app = actix_test::init_service(
            App::new()
                .wrap(RateLimit::new(&config))
                .route("/", web::get().to(|| async { HttpResponse::Ok().finish() })),
        )
        .await;

        let first = actix_test::TestRequest::get()
            .uri("/")
            .peer_addr("203.0.113.20:1234".parse().unwrap())
            .to_request();
        assert_eq!(actix_test::call_service(&app, first).await.status(), 200);

        let second = actix_test::TestRequest::get()
            .uri("/")
            .peer_addr("203.0.113.20:1234".parse().unwrap())
            .to_request();
        let response = actix_test::call_service(&app, second).await;
        assert_eq!(response.status(), 429);
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");
    }

    #[test]
    fn parses_plain_ip_and_socket_addr() {
        assert_eq!(
            parse_ip("203.0.113.10"),
            Some(IpAddr::from_str("203.0.113.10").unwrap())
        );
        assert_eq!(
            parse_ip("203.0.113.10:1234"),
            Some(IpAddr::from_str("203.0.113.10").unwrap())
        );
    }

    #[test]
    fn trusts_loopback_and_private_peers_only() {
        assert!(is_trusted_proxy_peer(
            IpAddr::from_str("127.0.0.1").unwrap()
        ));
        assert!(is_trusted_proxy_peer(
            IpAddr::from_str("172.18.0.2").unwrap()
        ));
        assert!(!is_trusted_proxy_peer(
            IpAddr::from_str("203.0.113.10").unwrap()
        ));
    }

    #[actix_web::test]
    async fn extracts_forwarded_ip_from_trusted_proxy_peer() {
        let req = actix_web::test::TestRequest::default()
            .peer_addr("172.18.0.2:4321".parse().unwrap())
            .insert_header(("x-forwarded-for", "203.0.113.10, 172.18.0.2"))
            .to_srv_request();

        let key = TrustedProxyIpKeyExtractor.extract(&req).unwrap();
        assert_eq!(key, IpAddr::from_str("203.0.113.10").unwrap());
    }

    #[actix_web::test]
    async fn ignores_forwarded_ip_from_untrusted_peer() {
        let req = actix_web::test::TestRequest::default()
            .peer_addr("198.51.100.7:4321".parse().unwrap())
            .insert_header(("x-forwarded-for", "203.0.113.10"))
            .to_srv_request();

        let key = TrustedProxyIpKeyExtractor.extract(&req).unwrap();
        assert_eq!(key, IpAddr::from_str("198.51.100.7").unwrap());
    }
}
