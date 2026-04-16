use serde::Deserialize;
use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateProfileRequest {
    #[validate(length(min = 3, max = 50))]
    pub username: Option<String>,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
    pub is_public: Option<bool>,
}
