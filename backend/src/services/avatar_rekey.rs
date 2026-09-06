//! Move avatars off the object key that anyone could guess.
//!
//! Uploads used to write `avatars/{user_id}.{ext}`. The account id is not
//! secret — it is in profile and search responses — so a profile that withholds
//! `avatar_url` from a viewer it has not approved still had its picture served
//! to anyone who asked for the obvious URL. That was M03 of the September 2026
//! audit.
//!
//! New uploads write `avatars/{user_id}/{nonce}.{ext}` instead, which closes it
//! for everyone who has changed their picture since. It does nothing for the
//! avatars already there, and those are exactly the accounts that predate the
//! fix. This moves them, once, so the finding is closed for the whole table
//! rather than for future uploads.
//!
//! Run it with `--rekey-avatars`. It is idempotent: an avatar already on a
//! nonce key is left alone, so a second run does nothing and a run interrupted
//! halfway can simply be repeated.

use sqlx::PgPool;
use uuid::Uuid;

use crate::services::storage::StorageService;

/// Largest avatar this will move. Uploads are bounded well below it; anything
/// larger is not an avatar this service wrote.
const MAX_AVATAR_BYTES: usize = 3 * 1024 * 1024;

/// Whether a key is the guessable shape — `avatars/{uuid}.{ext}`, no nonce.
///
/// Written as its own function so the decision is testable without R2: moving
/// the wrong object would delete somebody's picture.
pub fn is_guessable_avatar_key(key: &str) -> bool {
    let Some(name) = key.strip_prefix("avatars/") else {
        return false;
    };
    let Some((stem, _extension)) = name.rsplit_once('.') else {
        return false;
    };
    // A nonce key has a slash in the stem. Only the flat shape is guessable,
    // and it must still parse as a uuid — anything else is not ours to touch.
    !stem.contains('/') && Uuid::parse_str(stem).is_ok()
}

fn content_type_for(key: &str) -> &'static str {
    match key.rsplit_once('.').map(|(_, extension)| extension) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/jpeg",
    }
}

pub struct RekeyOutcome {
    pub examined: usize,
    pub moved: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Move every guessable avatar to a nonce key.
///
/// The order is the one the upload path learned to use: write the new object,
/// point the row at it, then delete the old one. A failure after the write
/// leaves an unreferenced object, which costs storage; a failure the other way
/// round would leave a row pointing at nothing, which costs the user their
/// picture.
pub async fn rekey_guessable_avatars(
    pool: &PgPool,
    storage: &StorageService,
) -> anyhow::Result<RekeyOutcome> {
    let rows = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, avatar_url FROM users WHERE avatar_url IS NOT NULL ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    let mut outcome = RekeyOutcome {
        examined: rows.len(),
        moved: 0,
        skipped: 0,
        failed: 0,
    };

    for (user_id, avatar_url) in rows {
        let Some(key) = storage.key_from_public_url(&avatar_url) else {
            // Someone else's URL, or a shape this service never wrote.
            outcome.skipped += 1;
            continue;
        };
        if !is_guessable_avatar_key(&key) {
            outcome.skipped += 1;
            continue;
        }

        match move_one(pool, storage, user_id, &key).await {
            Ok(()) => outcome.moved += 1,
            Err(error) => {
                // One unreadable object must not stop the rest. The count is
                // what the operator acts on.
                log::error!("avatar rekey failed for user_id={user_id} key={key}: {error}");
                outcome.failed += 1;
            }
        }
    }

    Ok(outcome)
}

async fn move_one(
    pool: &PgPool,
    storage: &StorageService,
    user_id: Uuid,
    old_key: &str,
) -> anyhow::Result<()> {
    let Some(bytes) = storage.get(old_key, MAX_AVATAR_BYTES).await? else {
        // The row points at an object that is gone. Leaving the URL alone keeps
        // this run from inventing a new key for bytes nobody has.
        anyhow::bail!("object is missing");
    };

    let extension = old_key.rsplit_once('.').map_or("jpg", |(_, ext)| ext);
    let new_key = format!("avatars/{user_id}/{}.{extension}", Uuid::new_v4());
    storage
        .put(&new_key, &bytes, content_type_for(old_key))
        .await?;

    let new_url = format!(
        "{}?v={}",
        storage.public_url(&new_key),
        Uuid::new_v4().simple()
    );
    let updated = sqlx::query(
        "UPDATE users SET avatar_url = $2, updated_at = NOW()
         WHERE id = $1 AND avatar_url IS NOT NULL",
    )
    .bind(user_id)
    .bind(&new_url)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        // The picture changed under this run. The object just written is not
        // referenced by anything, so remove it rather than leave litter.
        let _ = storage.delete(&new_key).await;
        anyhow::bail!("avatar changed while it was being moved");
    }

    // Last, and only now: the row no longer points here.
    storage.delete(old_key).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_flat_shape_counts_as_guessable() {
        let user = "11111111-1111-4111-8111-111111111111";
        let nonce = "22222222-2222-4222-8222-222222222222";

        assert!(is_guessable_avatar_key(&format!("avatars/{user}.jpg")));
        assert!(is_guessable_avatar_key(&format!("avatars/{user}.png")));

        // Already moved: leaving these alone is what makes a second run safe.
        assert!(!is_guessable_avatar_key(&format!(
            "avatars/{user}/{nonce}.jpg"
        )));
        // Not an avatar, and not ours to rewrite.
        assert!(!is_guessable_avatar_key("posters/w500/abc.jpg"));
        assert!(!is_guessable_avatar_key(&format!("avatars/{user}")));
        assert!(!is_guessable_avatar_key("avatars/not-a-uuid.jpg"));
    }

    #[test]
    fn the_content_type_follows_the_extension() {
        assert_eq!(content_type_for("avatars/a/b.png"), "image/png");
        assert_eq!(content_type_for("avatars/a/b.webp"), "image/webp");
        assert_eq!(content_type_for("avatars/a/b.gif"), "image/gif");
        // Both jpeg spellings, and anything unrecognised, keep the format the
        // upload validator would have accepted for a bare `.jpg`.
        assert_eq!(content_type_for("avatars/a/b.jpg"), "image/jpeg");
        assert_eq!(content_type_for("avatars/a/b.jpeg"), "image/jpeg");
    }
}
