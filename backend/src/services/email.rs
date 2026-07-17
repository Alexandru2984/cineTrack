use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::metrics;

/// Sends transactional email over SMTP. When SMTP is unavailable the service
/// logs reset URLs only outside production; production never exposes them.
#[derive(Clone)]
pub struct EmailService {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    from: String,
    log_reset_urls: bool,
}

impl EmailService {
    pub fn new(config: &Config) -> Self {
        let transport = config
            .smtp_host
            .as_deref()
            .and_then(|host| Self::build_transport(host, config));

        if transport.is_none() {
            if config.is_production() {
                log::warn!("SMTP unavailable; password-reset emails cannot be delivered");
            } else {
                log::warn!("SMTP unavailable; password-reset URLs will be logged for development");
            }
        }

        Self {
            transport,
            from: config.smtp_from.clone(),
            log_reset_urls: !config.is_production(),
        }
    }

    fn build_transport(host: &str, config: &Config) -> Option<AsyncSmtpTransport<Tokio1Executor>> {
        // Port 465 uses implicit TLS; everything else negotiates STARTTLS.
        let builder = if config.smtp_port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(host)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
        };

        let mut builder = match builder {
            Ok(b) => b
                .port(config.smtp_port)
                .timeout(Some(Duration::from_secs(config.smtp_timeout_seconds))),
            Err(e) => {
                log::error!("Failed to build SMTP transport: {e}");
                return None;
            }
        };

        if let (Some(user), Some(pass)) = (&config.smtp_username, &config.smtp_password) {
            builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
        }

        Some(builder.build())
    }

    /// Verify TLS negotiation and SMTP authentication without submitting mail.
    pub async fn check_connection(&self) -> Result<(), String> {
        let transport = self
            .transport
            .as_ref()
            .ok_or_else(|| "SMTP transport is not configured".to_string())?;
        match transport.test_connection().await {
            Ok(true) => Ok(()),
            Ok(false) => Err("SMTP server did not confirm the connection".to_string()),
            Err(error) => Err(format!("SMTP connection check failed: {error}")),
        }
    }

    /// Send a password-reset email. Errors are logged, never propagated, so the
    /// caller can keep its response uniform and avoid leaking whether the address
    /// exists.
    pub async fn send_password_reset(&self, to: &str, reset_url: &str) {
        let subject = "Reset your Văzute password";
        let body = format!(
            "We received a request to reset your Văzute password.\n\n\
             Open this link to choose a new password (valid for 1 hour):\n{reset_url}\n\n\
             If you didn't request this, you can safely ignore this email."
        );

        let Some(transport) = &self.transport else {
            metrics::record_email_send("password_reset", "not_configured");
            if self.log_reset_urls {
                log::info!("[email:log-only] to={to} subject={subject:?} reset_url={reset_url}");
            } else {
                log::warn!(
                    "SMTP unavailable; password-reset email was not sent and reset URL was not logged"
                );
            }
            return;
        };

        let from = match self.from.parse() {
            Ok(mailbox) => mailbox,
            Err(e) => {
                metrics::record_email_send("password_reset", "invalid_message");
                log::error!("Invalid SMTP_FROM address {:?}: {e}", self.from);
                return;
            }
        };
        let to = match to.parse() {
            Ok(mailbox) => mailbox,
            Err(e) => {
                metrics::record_email_send("password_reset", "invalid_message");
                log::error!("Invalid recipient address: {e}");
                return;
            }
        };

        let message = match Message::builder()
            .from(from)
            .to(to)
            .subject(subject)
            .body(body)
        {
            Ok(m) => m,
            Err(e) => {
                metrics::record_email_send("password_reset", "invalid_message");
                log::error!("Failed to build email message: {e}");
                return;
            }
        };

        let started_at = Instant::now();
        match transport.send(message).await {
            Ok(_) => {
                metrics::record_email_send("password_reset", "smtp_accepted");
                metrics::record_email_send_duration("password_reset", started_at.elapsed());
            }
            Err(e) => {
                metrics::record_email_send("password_reset", "smtp_error");
                metrics::record_email_send_duration("password_reset", started_at.elapsed());
                log::error!("Failed to send password-reset email: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(app_env: &str) -> Config {
        Config {
            app_env: app_env.to_string(),
            app_host: "127.0.0.1".to_string(),
            app_port: 0,
            frontend_url: "http://localhost:5173".to_string(),
            database_url: "postgres://example".to_string(),
            jwt_secret: "test_secret_must_be_64_chars_long_so_we_pad_it_here_abcdefghijklmnopq"
                .to_string(),
            jwt_expiry_minutes: 15,
            jwt_refresh_expiry_days: 30,
            tmdb_api_key: "fake".to_string(),
            tmdb_read_access_token: None,
            tmdb_base_url: "https://api.themoviedb.org/3".to_string(),
            tmdb_image_base_url: "https://image.tmdb.org/t/p".to_string(),
            tmdb_timeout_seconds: 10,
            cors_allowed_origins: vec!["http://localhost:5173".to_string()],
            rate_limit_rps: 10,
            rate_limit_burst: 50,
            smtp_host: None,
            smtp_port: 587,
            smtp_username: None,
            smtp_password: None,
            smtp_from: "CineTrack <noreply@localhost>".to_string(),
            smtp_timeout_seconds: 15,
            r2: None,
        }
    }

    #[test]
    fn log_only_reset_urls_are_disabled_in_production() {
        let service = EmailService::new(&test_config("production"));
        assert!(!service.log_reset_urls);
    }

    #[test]
    fn log_only_reset_urls_remain_enabled_outside_production() {
        let service = EmailService::new(&test_config("development"));
        assert!(service.log_reset_urls);
    }

    #[tokio::test]
    async fn connection_check_rejects_an_unconfigured_transport() {
        let service = EmailService::new(&test_config("development"));
        assert_eq!(
            service.check_connection().await,
            Err("SMTP transport is not configured".to_string())
        );
    }
}
