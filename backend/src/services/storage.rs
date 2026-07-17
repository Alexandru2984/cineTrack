use anyhow::Context;
use aws_sdk_s3::config::{
    Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use aws_smithy_types::timeout::TimeoutConfig;

use crate::config::R2Config;

pub const AVATAR_EXTENSIONS: &[&str] = &["png", "jpg", "webp", "gif"];

/// Thin wrapper over a Cloudflare R2 (S3-compatible) bucket. Cheap to clone.
#[derive(Clone)]
pub struct StorageService {
    client: Client,
    bucket: String,
    public_base_url: Option<String>,
    /// Site origin used to build absolute proxy URLs when no public bucket
    /// domain is configured (e.g. https://vazute.micutu.com).
    proxy_origin: String,
}

impl StorageService {
    pub fn new(cfg: &R2Config, proxy_origin: &str) -> anyhow::Result<Self> {
        let creds = Credentials::new(
            cfg.access_key_id.clone(),
            cfg.secret_access_key.clone(),
            None,
            None,
            "cinetrack-r2",
        );
        let timeouts = TimeoutConfig::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .read_timeout(std::time::Duration::from_secs(15))
            .operation_attempt_timeout(std::time::Duration::from_secs(20))
            .operation_timeout(std::time::Duration::from_secs(30))
            .build();
        let sdk_config = aws_sdk_s3::Config::builder()
            .credentials_provider(creds)
            .region(Region::new("auto"))
            .endpoint_url(cfg.endpoint.clone())
            .force_path_style(true)
            // R2 does not implement every optional AWS checksum extension.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .timeout_config(timeouts)
            .build();
        Ok(Self {
            client: Client::from_conf(sdk_config),
            bucket: cfg.bucket.clone(),
            public_base_url: cfg.public_base_url.clone(),
            proxy_origin: proxy_origin.trim_end_matches('/').to_string(),
        })
    }

    pub async fn put(&self, key: &str, data: &[u8], content_type: &str) -> anyhow::Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(content_type)
            .body(ByteStream::from(data.to_vec()))
            .send()
            .await
            .context("R2 put failed")?;
        Ok(())
    }

    pub async fn get(&self, key: &str, max_bytes: usize) -> anyhow::Result<Option<Vec<u8>>> {
        let output = match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(output) => output,
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|service| service.is_no_such_key()) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(anyhow::Error::new(error).context("R2 get failed")),
        };

        let declared_len = output
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .context("R2 response has no valid content length")?;
        if declared_len > max_bytes {
            anyhow::bail!("R2 object exceeds the allowed size");
        }
        let bytes = output
            .body
            .collect()
            .await
            .context("R2 response body failed")?
            .into_bytes();
        if bytes.len() > max_bytes {
            anyhow::bail!("R2 object exceeds the allowed size");
        }
        Ok(Some(bytes.to_vec()))
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .context("R2 delete failed")?;
        Ok(())
    }

    pub async fn delete_avatar_variants(&self, user_id: uuid::Uuid) -> anyhow::Result<()> {
        self.delete_avatar_variants_except(user_id, None).await
    }

    pub async fn delete_other_avatar_variants(
        &self,
        user_id: uuid::Uuid,
        retained_extension: &str,
    ) -> anyhow::Result<()> {
        self.delete_avatar_variants_except(user_id, Some(retained_extension))
            .await
    }

    async fn delete_avatar_variants_except(
        &self,
        user_id: uuid::Uuid,
        retained_extension: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut first_error = None;
        for extension in AVATAR_EXTENSIONS {
            if retained_extension == Some(*extension) {
                continue;
            }
            let key = format!("avatars/{user_id}.{extension}");
            if let Err(error) = self.delete(&key).await {
                if first_error.is_none() {
                    first_error = Some(error.context(format!("failed to delete {key}")));
                }
            }
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Absolute public URL for an object: the configured bucket domain when set,
    /// otherwise the site origin + backend proxy path that streams the object.
    pub fn public_url(&self, key: &str) -> String {
        match &self.public_base_url {
            Some(base) => format!("{base}/{key}"),
            None => format!("{}/api/assets/{key}", self.proxy_origin),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    #[ignore = "requires production R2 credentials"]
    async fn r2_round_trip() {
        dotenvy::from_path("../.env.prod").ok();
        let cfg = R2Config {
            endpoint: std::env::var("R2_S3_API")
                .or_else(|_| std::env::var("R2_ENDPOINT"))
                .expect("R2 endpoint"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("R2 access key"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("R2 secret key"),
            bucket: std::env::var("R2_BUCKET").expect("R2 bucket"),
            public_base_url: None,
        };
        let storage = StorageService::new(&cfg, "http://localhost").unwrap();
        let key = format!("smoke/storage-{}.txt", Uuid::new_v4());
        let expected = b"cinetrack storage smoke test";

        storage.put(&key, expected, "text/plain").await.unwrap();
        let actual = storage.get(&key, 1024).await.unwrap().unwrap();
        storage.delete(&key).await.unwrap();

        assert_eq!(actual, expected);
        assert!(storage.get(&key, 1024).await.unwrap().is_none());
    }
}
