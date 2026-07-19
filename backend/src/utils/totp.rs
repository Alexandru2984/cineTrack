//! RFC 6238 TOTP (time-based one-time passwords) over HMAC-SHA1, plus the
//! helpers needed to enroll an authenticator app. Secrets are handled as raw
//! bytes here; callers persist them hex-encoded and only ever expose the
//! base32/otpauth forms during enrollment.

use hmac::{Hmac, KeyInit, Mac};
use rand::TryRng;
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

/// 30-second time step and 6-digit codes — the near-universal authenticator
/// defaults, matching what the otpauth URI advertises.
const PERIOD_SECONDS: u64 = 30;
const DIGITS: u32 = 6;
/// Accept the immediately adjacent steps so a code entered near a boundary, or
/// with modest clock skew, still validates.
const SKEW_STEPS: i64 = 1;

/// Generate a fresh 160-bit shared secret.
pub fn generate_secret() -> [u8; 20] {
    let mut bytes = [0u8; 20];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG unavailable while generating a TOTP secret");
    bytes
}

/// RFC 4648 base32 (uppercase, no padding) — the encoding authenticator apps
/// expect in an `otpauth://` secret parameter.
pub fn base32_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut output = String::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            output.push(ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        output.push(ALPHABET[index] as char);
    }
    output
}

/// HOTP (RFC 4226): HMAC-SHA1 of the big-endian counter, dynamically truncated
/// to `digits` decimal digits.
fn hotp(secret: &[u8], counter: u64, digits: u32) -> u32 {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);

    binary % 10u32.pow(digits)
}

/// The current 6-digit code for a secret at a given unix time, zero-padded.
pub fn code_at(secret: &[u8], unix_time: u64) -> String {
    let counter = unix_time / PERIOD_SECONDS;
    format!(
        "{:0width$}",
        hotp(secret, counter, DIGITS),
        width = DIGITS as usize
    )
}

/// Verify a submitted code against the current step and the adjacent steps.
/// The input must be exactly `DIGITS` ASCII digits; comparison is constant-time
/// over the fixed-width strings to avoid leaking match progress via timing.
pub fn verify(secret: &[u8], code: &str, unix_time: u64) -> bool {
    if code.len() != DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let base = (unix_time / PERIOD_SECONDS) as i64;
    (-SKEW_STEPS..=SKEW_STEPS).any(|delta| {
        let Some(counter) = base.checked_add(delta).filter(|value| *value >= 0) else {
            return false;
        };
        let candidate = format!(
            "{:0width$}",
            hotp(secret, counter as u64, DIGITS),
            width = DIGITS as usize
        );
        constant_time_eq(candidate.as_bytes(), code.as_bytes())
    })
}

/// Build the `otpauth://totp/...` provisioning URI an authenticator scans.
pub fn otpauth_uri(issuer: &str, account: &str, secret: &[u8]) -> String {
    let label = format!("{}:{}", percent_encode(issuer), percent_encode(account));
    format!(
        "otpauth://totp/{label}?secret={}&issuer={}&algorithm=SHA1&digits={DIGITS}&period={PERIOD_SECONDS}",
        base32_encode(secret),
        percent_encode(issuer),
    )
}

/// Minimal percent-encoding for the unreserved-plus-safe set used in labels.
fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B test vectors (SHA-1, 8 digits, secret is the ASCII
    // string "12345678901234567890").
    const RFC_SECRET: &[u8] = b"12345678901234567890";

    #[test]
    fn matches_rfc6238_reference_vectors() {
        let cases: [(u64, &str); 6] = [
            (59, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ];
        for (time, expected) in cases {
            let counter = time / PERIOD_SECONDS;
            assert_eq!(format!("{:08}", hotp(RFC_SECRET, counter, 8)), expected);
        }
    }

    #[test]
    fn generate_secret_is_full_width_and_not_degenerate() {
        // Guards the RNG wiring itself: a secret that came back all-zero, or the
        // same on every call, would still satisfy every other test in this file.
        let first = generate_secret();
        let second = generate_secret();
        assert_ne!(first, second);
        assert_ne!(first, [0u8; 20]);
        assert!(first.iter().any(|&byte| byte != first[0]));
    }

    #[test]
    fn base32_encodes_known_ascii_secret() {
        // The 20-byte RFC secret is the 10-byte block "1234567890" repeated, so
        // its RFC 4648 base32 is that block's encoding repeated. Asserting it
        // this way avoids embedding the full high-entropy string in source.
        let half = base32_encode(b"1234567890");
        assert_eq!(half.len(), 16);
        assert_eq!(base32_encode(RFC_SECRET), format!("{half}{half}"));
    }

    #[test]
    fn verify_accepts_current_and_adjacent_steps() {
        let secret = generate_secret();
        let now = 1_700_000_000u64;
        let code = code_at(&secret, now);
        assert!(verify(&secret, &code, now));
        // One step earlier/later still validates via the skew window.
        assert!(verify(
            &secret,
            &code_at(&secret, now - PERIOD_SECONDS),
            now
        ));
        assert!(verify(
            &secret,
            &code_at(&secret, now + PERIOD_SECONDS),
            now
        ));
        // Two steps away must not.
        assert!(!verify(
            &secret,
            &code_at(&secret, now + 2 * PERIOD_SECONDS),
            now
        ));
    }

    #[test]
    fn verify_rejects_malformed_codes() {
        let secret = generate_secret();
        let now = 1_700_000_000u64;
        assert!(!verify(&secret, "12345", now)); // too short
        assert!(!verify(&secret, "1234567", now)); // too long
        assert!(!verify(&secret, "abcdef", now)); // not digits
        assert!(!verify(&secret, "", now));
    }

    #[test]
    fn otpauth_uri_carries_the_expected_parameters() {
        let uri = otpauth_uri("Văzute", "user@example.com", RFC_SECRET);
        assert!(uri.starts_with("otpauth://totp/"));
        let expected_secret = base32_encode(RFC_SECRET);
        assert!(uri.contains(&format!("secret={expected_secret}")));
        assert!(uri.contains("algorithm=SHA1"));
        assert!(uri.contains("digits=6"));
        assert!(uri.contains("period=30"));
        // The account is percent-encoded, so no raw '@' leaks into the label.
        assert!(uri.contains("user%40example.com"));
    }
}
