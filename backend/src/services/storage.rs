use anyhow::Context;
use s3::creds::Credentials;
use s3::{Bucket, Region};

use crate::config::R2Config;

/// Thin wrapper over a Cloudflare R2 (S3-compatible) bucket. Cheap to clone.
#[derive(Clone)]
pub struct StorageService {
    bucket: Box<Bucket>,
    public_base_url: Option<String>,
    /// Site origin used to build absolute proxy URLs when no public bucket
    /// domain is configured (e.g. https://vazute.micutu.com).
    proxy_origin: String,
    http: reqwest::Client,
}

impl StorageService {
    pub fn new(cfg: &R2Config, proxy_origin: &str) -> anyhow::Result<Self> {
        let region = Region::Custom {
            region: "auto".to_string(),
            endpoint: cfg.endpoint.clone(),
        };
        let creds = Credentials::new(
            Some(&cfg.access_key_id),
            Some(&cfg.secret_access_key),
            None,
            None,
            None,
        )
        .context("invalid R2 credentials")?;
        // R2 works with path-style addressing against the account endpoint.
        let bucket = Bucket::new(&cfg.bucket, region, creds)
            .context("failed to init R2 bucket")?
            .with_path_style();
        Ok(Self {
            bucket,
            public_base_url: cfg.public_base_url.clone(),
            proxy_origin: proxy_origin.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .context("failed to build storage HTTP client")?,
        })
    }

    pub async fn put(&self, key: &str, data: &[u8], content_type: &str) -> anyhow::Result<()> {
        let resp = self
            .bucket
            .put_object_with_content_type(key, data, content_type)
            .await
            .context("R2 put failed")?;
        let code = resp.status_code();
        if !(200..300).contains(&code) {
            anyhow::bail!("R2 put returned status {code}");
        }
        Ok(())
    }

    pub async fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        match self.bucket.get_object(key).await {
            Ok(resp) if (200..300).contains(&resp.status_code()) => Ok(Some(resp.bytes().to_vec())),
            Ok(resp) if resp.status_code() == 404 => Ok(None),
            Ok(resp) => anyhow::bail!("R2 get returned status {}", resp.status_code()),
            Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Ok(None),
            Err(e) => Err(anyhow::Error::new(e).context("R2 get failed")),
        }
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        // rust-s3's header-signed DELETE is rejected by R2 (403); a presigned URL
        // (query-string auth) executed over plain HTTP works reliably.
        let url = self
            .bucket
            .presign_delete(key, 300)
            .await
            .context("failed to presign R2 delete")?;
        let code = self
            .http
            .delete(&url)
            .send()
            .await
            .context("R2 delete request failed")?
            .status()
            .as_u16();
        // 204 on success, 404 if already gone — both are fine.
        if !(200..300).contains(&code) && code != 404 {
            anyhow::bail!("R2 delete returned status {code}");
        }
        Ok(())
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
