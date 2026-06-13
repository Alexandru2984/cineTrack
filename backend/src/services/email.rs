use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Config;

/// Sends transactional email over SMTP. When SMTP is not configured the service
/// degrades gracefully: it logs what it would have sent (useful in dev) instead
/// of failing, so flows like password reset never break on a missing mailer.
#[derive(Clone)]
pub struct EmailService {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    from: String,
}

impl EmailService {
    pub fn new(config: &Config) -> Self {
        let transport = config
            .smtp_host
            .as_deref()
            .and_then(|host| Self::build_transport(host, config));

        if transport.is_none() {
            log::warn!("SMTP not configured; emails will be logged instead of sent");
        }

        Self {
            transport,
            from: config.smtp_from.clone(),
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
            Ok(b) => b.port(config.smtp_port),
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

    /// Send a password-reset email. Errors are logged, never propagated, so the
    /// caller can keep its response uniform and avoid leaking whether the address
    /// exists.
    pub async fn send_password_reset(&self, to: &str, reset_url: &str) {
        let subject = "Reset your CineTrack password";
        let body = format!(
            "We received a request to reset your CineTrack password.\n\n\
             Open this link to choose a new password (valid for 1 hour):\n{reset_url}\n\n\
             If you didn't request this, you can safely ignore this email."
        );

        let Some(transport) = &self.transport else {
            log::info!("[email:log-only] to={to} subject={subject:?} reset_url={reset_url}");
            return;
        };

        let from = match self.from.parse() {
            Ok(mailbox) => mailbox,
            Err(e) => {
                log::error!("Invalid SMTP_FROM address {:?}: {e}", self.from);
                return;
            }
        };
        let to = match to.parse() {
            Ok(mailbox) => mailbox,
            Err(e) => {
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
                log::error!("Failed to build email message: {e}");
                return;
            }
        };

        if let Err(e) = transport.send(message).await {
            log::error!("Failed to send password-reset email: {e}");
        }
    }
}
