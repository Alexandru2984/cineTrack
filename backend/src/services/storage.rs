use std::sync::LazyLock;

use anyhow::Context;
use aws_sdk_s3::config::{
    Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use aws_smithy_types::timeout::TimeoutConfig;
use tokio::sync::Semaphore;

use crate::config::R2Config;

pub const AVATAR_EXTENSIONS: &[&str] = &["png", "jpg", "webp", "gif"];

/// How many object reads may be in flight at once.
///
/// Each one holds its whole object in memory — up to `MAX_AVATAR_BYTES` or
/// `MAX_POSTER_BYTES` — and the per-object limit says nothing about how many
/// arrive together. The API container has 512 MiB, so a grid of cards on a
/// cold cache could ask for more of it than exists. Eight is roughly 120 MiB
/// at the largest allowed object, which leaves the rest of the process room.
///
/// Waiting is the right behaviour here rather than refusing: these are image
/// reads behind a cache, and a short queue is invisible where a 503 is not.
const CONCURRENT_OBJECT_READS: usize = 8;

static OBJECT_READ_SLOTS: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(CONCURRENT_OBJECT_READS));

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
        // Held for the whole read, including the body collection below, because
        // that is the part that holds the object in memory.
        let _slot = OBJECT_READ_SLOTS
            .acquire()
            .await
            .context("object read budget closed")?;

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
        // `into()` rather than `to_vec()`: the aggregated body is the only owner
        // here, so this hands the buffer over instead of copying it a second
        // time. At fifteen megabytes the difference is worth the word.
        Ok(Some(bytes.into()))
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

    /// Remove every object under a prefix.
    ///
    /// Avatar keys carry a per-upload nonce so two uploads cannot overwrite or
    /// delete each other's object, which means "this member's avatars" is no
    /// longer a short list of known extensions that can be deleted blind. It is
    /// whatever is there, so removal has to ask.
    ///
    /// Used where the answer must be complete — deleting an avatar, deleting an
    /// account — rather than on the upload path, which knows the exact key it
    /// is replacing.
    pub async fn delete_prefix(&self, prefix: &str) -> anyhow::Result<()> {
        let mut continuation: Option<String> = None;
        let mut first_error: Option<anyhow::Error> = None;

        loop {
            let mut request = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);
            if let Some(token) = continuation.as_ref() {
                request = request.continuation_token(token);
            }
            let page = request
                .send()
                .await
                .context("R2 list for prefix delete failed")?;

            for object in page.contents() {
                if let Some(key) = object.key() {
                    if let Err(error) = self.delete(key).await {
                        // Keep going: one object that will not go away must not
                        // leave the rest of the member's images behind it.
                        if first_error.is_none() {
                            first_error = Some(error.context(format!("failed to delete {key}")));
                        }
                    }
                }
            }

            if page.is_truncated().unwrap_or(false) {
                continuation = page.next_continuation_token().map(str::to_string);
                if continuation.is_none() {
                    break;
                }
            } else {
                break;
            }
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Every avatar this member has, whatever it is keyed as.
    ///
    /// Covers both the versioned keys written now and the single
    /// `avatars/{id}.{ext}` written before them, so an account deleted today
    /// does not leave an image uploaded last year.
    pub async fn delete_avatar_variants(&self, user_id: uuid::Uuid) -> anyhow::Result<()> {
        let versioned = self.delete_prefix(&format!("avatars/{user_id}/")).await;
        let legacy = self.delete_avatar_variants_except(user_id, None).await;
        versioned.and(legacy)
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

    /// The object a stored `avatar_url` points at, if it points at one of ours.
    ///
    /// Uploads keep the key they replaced so they can delete exactly that, and
    /// the row holds a URL rather than a key. A URL from some other origin, or
    /// one shaped differently from what `public_url` writes, yields `None`
    /// rather than a guess — deleting an object because a string looked close
    /// enough is not a trade worth making.
    pub fn key_from_public_url(&self, url: &str) -> Option<String> {
        avatar_key_from_public_url(url, self.public_base_url.as_deref(), &self.proxy_origin)
    }
}

/// The object a stored `avatar_url` points at, if it points at one of ours.
///
/// Split from the service because it is pure string work and the service owns
/// an S3 client no unit test can build. Getting this wrong permissively deletes
/// somebody else's object and strictly leaves litter, so anything that is not
/// recognisably one of ours yields `None` rather than a guess.
fn avatar_key_from_public_url(
    url: &str,
    public_base_url: Option<&str>,
    proxy_origin: &str,
) -> Option<String> {
    // Uploads append `?v=` so caches do not serve the previous image.
    let without_query = url.split('?').next().unwrap_or(url);
    let key = match public_base_url {
        Some(base) => without_query.strip_prefix(&format!("{base}/"))?,
        None => without_query.strip_prefix(&format!("{proxy_origin}/api/assets/"))?,
    };
    // Nothing outside the avatar prefix, and nothing that climbs out of it.
    if !key.starts_with("avatars/") || key.contains("..") {
        return None;
    }
    Some(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// A stored avatar URL round-trips back to the object it names.
    #[test]
    fn public_urls_map_back_to_their_key() {
        let base = Some("https://cdn.example.test");
        let origin = "https://site.example";
        let key = "avatars/11111111-1111-4111-8111-111111111111/2222222222224444.jpg";

        assert_eq!(
            avatar_key_from_public_url(&format!("https://cdn.example.test/{key}"), base, origin)
                .as_deref(),
            Some(key)
        );
        // Uploads append a cache-busting query; the object is the same.
        assert_eq!(
            avatar_key_from_public_url(
                &format!("https://cdn.example.test/{key}?v=abc"),
                base,
                origin
            )
            .as_deref(),
            Some(key)
        );
        // And through the proxy origin, when no bucket domain is configured.
        assert_eq!(
            avatar_key_from_public_url(&format!("{origin}/api/assets/{key}"), None, origin)
                .as_deref(),
            Some(key)
        );

        // Anything else is not ours to delete.
        for foreign in [
            "https://elsewhere.test/avatars/x.jpg",
            "https://cdn.example.test/posters/w500/x.jpg",
            "https://cdn.example.test/avatars/../backups/dump.gz",
            "https://cdn.example.test/backups/dump.gz",
        ] {
            assert_eq!(
                avatar_key_from_public_url(foreign, base, origin),
                None,
                "{foreign} was treated as an object this service may delete"
            );
        }
    }

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
