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
use std::sync::{Arc, OnceLock};
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
        } else if forwarded_for_ip(req).is_some() {
            note_untrusted_forwarding(peer_ip);
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

    let stated = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .and_then(parse_ip);

    if is_trusted_proxy_peer(peer_ip) {
        if let Some(forwarded) = stated {
            return Some(forwarded);
        }
    } else if stated.is_some() {
        note_untrusted_forwarding(peer_ip);
    }

    Some(peer_ip)
}

fn parse_ip(value: &str) -> Option<IpAddr> {
    IpAddr::from_str(value)
        .ok()
        .or_else(|| SocketAddr::from_str(value).ok().map(|socket| socket.ip()))
}

/// Peers allowed to state a client's address on that client's behalf.
///
/// `None` means the old rule: any loopback or RFC1918 peer. That was written
/// for a box running one thing behind one proxy, and this one is not — it
/// serves about seventy other sites, most of them containers on their own
/// bridge networks. Docker publishes this backend with an explicit accept:
///
/// ```text
/// -A DOCKER -d 172.26.0.2/32 ! -i br-… -o br-… -p tcp --dport 8080 -j ACCEPT
/// ```
///
/// which sits *above* the cross-bridge DROP. So a neighbouring container can
/// open a connection straight to the application, skip nginx entirely, and
/// name any client IP it likes — spending someone else's rate-limit budget, or
/// evading its own. Its source address is RFC1918, so the old rule believed it.
///
/// `TRUSTED_PROXY_IPS` replaces the range with an exact list. Set it to the
/// address the real proxy's traffic arrives from and nothing else.
fn trusted_proxies() -> Option<&'static [IpAddr]> {
    static TRUSTED: OnceLock<Option<Vec<IpAddr>>> = OnceLock::new();
    TRUSTED
        .get_or_init(|| {
            parse_trusted_proxies(std::env::var("TRUSTED_PROXY_IPS").ok().as_deref())
                .unwrap_or_else(|invalid| {
                    panic!("TRUSTED_PROXY_IPS contains an address that is not an IP: {invalid}")
                })
        })
        .as_deref()
}

/// Read the allowlist, refusing anything it cannot parse.
///
/// A typo is rejected rather than skipped. Dropping an unreadable entry would
/// quietly shrink the list, and a list that shrinks to nothing stops trusting
/// the real proxy — at which point every visitor shares one rate-limit bucket
/// and the site limits itself. Failing at startup is the mild version of that,
/// and `--check-config` runs before a deployment swaps anything over.
fn parse_trusted_proxies(value: Option<&str>) -> Result<Option<Vec<IpAddr>>, String> {
    let Some(raw) = value else { return Ok(None) };
    let mut parsed = Vec::new();
    for entry in raw.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        parsed.push(IpAddr::from_str(entry).map_err(|_| entry.to_string())?);
    }
    // An empty or whitespace-only value means "not configured", not "trust
    // nobody": the second reading turns a blank line in an env file into a
    // site-wide outage.
    Ok((!parsed.is_empty()).then_some(parsed))
}

/// Read the allowlist once at startup, and say what it decided.
///
/// Called from `main` so `--check-config` — which a deployment runs before it
/// swaps anything over — refuses a malformed `TRUSTED_PROXY_IPS` while the old
/// process is still serving. Without this the value is first read on the first
/// request, which is a poor moment to discover a typo.
///
/// The line it logs is also the record of which rule is in force, so "who does
/// this box trust to name a client" is answerable from the logs rather than by
/// re-reading this file.
pub fn describe_trusted_proxies() -> String {
    match trusted_proxies() {
        Some(allowed) => format!(
            "X-Forwarded-For accepted only from {}",
            allowed
                .iter()
                .map(|ip| ip.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        None => "X-Forwarded-For accepted from any loopback or private peer                  (TRUSTED_PROXY_IPS is not set)"
            .to_string(),
    }
}

fn is_trusted_proxy_peer(ip: IpAddr) -> bool {
    match trusted_proxies() {
        Some(allowed) => allowed.contains(&ip),
        None => is_private_or_loopback(ip),
    }
}

fn is_private_or_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
        IpAddr::V6(ip) => ip.is_loopback() || ((ip.segments()[0] & 0xfe00) == 0xfc00),
    }
}

/// Say something when a peer that is not the proxy tries to speak for a client.
///
/// Two things look like this and both are worth knowing about. One is the
/// attack above. The other is drift: Docker renumbers its bridge, the real
/// proxy starts arriving from an address that is no longer on the list, and
/// every visitor collapses into one bucket. That would otherwise be discovered
/// as a site-wide wave of 429s.
///
/// Throttled to one line a minute, because under the attack it would otherwise
/// be one line per request.
fn note_untrusted_forwarding(peer: IpAddr) {
    const QUIET_SECONDS: u64 = 60;
    static LAST_LOGGED: AtomicU64 = AtomicU64::new(0);

    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return;
    };
    let now = now.as_secs();
    let last = LAST_LOGGED.load(Ordering::Relaxed);
    if now.saturating_sub(last) < QUIET_SECONDS {
        return;
    }
    if LAST_LOGGED
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    log::warn!(
        "audit: ignored X-Forwarded-For from untrusted peer {peer};          either something is reaching the application directly, or TRUSTED_PROXY_IPS          no longer names the address the proxy arrives from"
    );
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

    /// The fallback, for a deployment that has not named its proxy.
    ///
    /// Read `is_private_or_loopback` rather than `is_trusted_proxy_peer`: the
    /// latter consults a process-wide `OnceLock`, and a test that initialised it
    /// would decide the answer for every other test in the binary.
    #[test]
    fn without_an_allowlist_it_falls_back_to_loopback_and_private_peers() {
        assert!(is_private_or_loopback(
            IpAddr::from_str("127.0.0.1").unwrap()
        ));
        assert!(is_private_or_loopback(
            IpAddr::from_str("172.18.0.2").unwrap()
        ));
        assert!(!is_private_or_loopback(
            IpAddr::from_str("203.0.113.10").unwrap()
        ));
    }

    /// The point of the allowlist: a private address is no longer a credential.
    ///
    /// This host publishes the application with a Docker rule that accepts
    /// cross-bridge traffic to its port, so a neighbouring container really can
    /// reach it directly. Under the old rule its RFC1918 source address was
    /// enough to be believed about who the client was.
    #[test]
    fn an_allowlist_admits_only_the_addresses_it_names() {
        let allowed = parse_trusted_proxies(Some("172.26.0.1")).unwrap().unwrap();
        assert!(allowed.contains(&IpAddr::from_str("172.26.0.1").unwrap()));
        // A neighbour on another bridge. Private, and not the proxy.
        assert!(!allowed.contains(&IpAddr::from_str("172.25.0.14").unwrap()));
        // Loopback stops being special once the real peer has been named.
        assert!(!allowed.contains(&IpAddr::from_str("127.0.0.1").unwrap()));
    }

    #[test]
    fn an_allowlist_accepts_several_addresses_and_ignores_spacing() {
        let allowed = parse_trusted_proxies(Some(" 172.26.0.1 , 10.0.0.8,, ::1 "))
            .unwrap()
            .unwrap();
        assert_eq!(allowed.len(), 3);
        assert!(allowed.contains(&IpAddr::from_str("::1").unwrap()));
    }

    /// Blank is "not configured", not "trust nobody".
    ///
    /// Reading it the second way would turn an empty line in an env file into a
    /// site-wide outage: with no trusted proxy, every visitor arrives as the
    /// same gateway address and shares one rate-limit bucket.
    #[test]
    fn a_blank_setting_means_unconfigured_rather_than_empty() {
        assert!(parse_trusted_proxies(None).unwrap().is_none());
        assert!(parse_trusted_proxies(Some("")).unwrap().is_none());
        assert!(parse_trusted_proxies(Some("  ,  ")).unwrap().is_none());
    }

    /// A typo is refused, not skipped past.
    ///
    /// Silently dropping it would shrink the list without saying so, and the
    /// smaller list is the dangerous one.
    #[test]
    fn a_malformed_entry_is_refused_rather_than_dropped() {
        assert_eq!(
            parse_trusted_proxies(Some("172.26.0.1, not-an-ip")),
            Err("not-an-ip".to_string())
        );
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
