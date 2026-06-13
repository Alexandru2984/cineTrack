use actix_governor::{KeyExtractor, SimpleKeyExtractionError};
use actix_web::dev::ServiceRequest;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedProxyIpKeyExtractor;

impl KeyExtractor for TrustedProxyIpKeyExtractor {
    type Key = IpAddr;
    type KeyExtractionError = SimpleKeyExtractionError<&'static str>;

    fn extract(&self, req: &ServiceRequest) -> Result<Self::Key, Self::KeyExtractionError> {
        let peer_ip = req.peer_addr().map(|socket| socket.ip()).ok_or_else(|| {
            SimpleKeyExtractionError::new("Could not extract peer IP address from request")
        })?;

        if is_trusted_proxy_peer(peer_ip) {
            if let Some(forwarded_ip) = forwarded_for_ip(req) {
                return Ok(forwarded_ip);
            }
        }

        Ok(peer_ip)
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
