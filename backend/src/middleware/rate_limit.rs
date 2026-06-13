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
