use std::time::Duration;

use sha1::{Digest, Sha1};

use crate::config::Config;
use crate::errors::AppError;

/// Base URL of the Have I Been Pwned "range" (k-anonymity) API. Only the first
/// five hex characters of the password's SHA-1 hash ever leave this process, so
/// the plaintext and full hash are never disclosed to the upstream service.
const HIBP_RANGE_BASE_URL: &str = "https://api.pwnedpasswords.com/range";

/// Checks a candidate password against the public breach corpus using the
/// k-anonymity model. The check is best-effort: any network/parse failure is
/// treated as "not breached" (fail-open) so account creation and password
/// changes never depend on a third-party's availability.
#[derive(Clone)]
pub struct BreachChecker {
    client: Option<reqwest::Client>,
    range_base_url: String,
}

impl BreachChecker {
    pub fn new(config: &Config) -> Self {
        let client = if config.breached_password_check {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(4))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("cinetrack-breach-check")
                .build()
                .map_err(|error| log::error!("breach checker client init failed: {error}"))
                .ok()
        } else {
            None
        };
        Self {
            client,
            range_base_url: HIBP_RANGE_BASE_URL.to_string(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.client.is_some()
    }

    /// Reject the password if it appears in a known breach. Returns `Ok(())`
    /// when the check is disabled, when the password is clean, or when the
    /// upstream lookup fails for any reason.
    pub async fn ensure_not_breached(&self, password: &str) -> Result<(), AppError> {
        let Some(client) = self.client.as_ref() else {
            return Ok(());
        };

        let (prefix, suffix) = sha1_prefix_suffix(password);
        let url = format!("{}/{prefix}", self.range_base_url);
        let response = match client
            .get(&url)
            // Padding hides the true result size from a network observer.
            .header("Add-Padding", "true")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
        {
            Ok(response) => response,
            Err(error) => {
                log::warn!("breach check lookup failed (fail-open): {error}");
                return Ok(());
            }
        };

        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                log::warn!("breach check body read failed (fail-open): {error}");
                return Ok(());
            }
        };

        match breach_count(&body, &suffix) {
            Some(count) if count > 0 => Err(AppError::BadRequest(
                "This password has appeared in a known data breach. Please choose a different one."
                    .to_string(),
            )),
            _ => Ok(()),
        }
    }
}

/// Split a password's uppercase SHA-1 hex digest into the 5-char range prefix
/// and the 35-char suffix compared against the API response.
fn sha1_prefix_suffix(password: &str) -> (String, String) {
    let digest = Sha1::digest(password.as_bytes());
    let hex = hex::encode_upper(digest);
    let (prefix, suffix) = hex.split_at(5);
    (prefix.to_string(), suffix.to_string())
}

/// Parse a HIBP range response ("SUFFIX:COUNT" per line) and return the breach
/// count for the given suffix, or None if absent. Padding rows carry a 0 count.
fn breach_count(body: &str, suffix: &str) -> Option<u64> {
    body.lines().find_map(|line| {
        let (line_suffix, count) = line.trim().split_once(':')?;
        if line_suffix.eq_ignore_ascii_case(suffix) {
            count.trim().parse::<u64>().ok()
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_sha1_prefix_and_suffix() {
        // Known SHA-1 of "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
        let (prefix, suffix) = sha1_prefix_suffix("password");
        assert_eq!(prefix, "5BAA6");
        assert_eq!(suffix, "1E4C9B93F3F0682250B6CF8331B7EE68FD8");
    }

    #[test]
    fn finds_breach_count_case_insensitively() {
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n\
                    1E4C9B93F3F0682250B6CF8331B7EE68FD8:3730471\r\n\
                    003D68EB55068C33ACE09247EE4C639306B:0";
        assert_eq!(
            breach_count(body, "1e4c9b93f3f0682250b6cf8331b7ee68fd8"),
            Some(3_730_471)
        );
    }

    #[test]
    fn absent_suffix_is_not_breached() {
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n\
                    003D68EB55068C33ACE09247EE4C639306B:0";
        assert_eq!(breach_count(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"), None);
    }

    #[test]
    fn padding_row_reports_zero_count() {
        let body = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:0";
        assert_eq!(breach_count(body, "1E4C9B93F3F0682250B6CF8331B7EE68FD8"), Some(0));
    }
}
