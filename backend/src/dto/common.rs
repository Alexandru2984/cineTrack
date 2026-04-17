use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct PaginationParams {
    pub page: Option<u32>,
    pub limit: Option<u32>,
}

impl PaginationParams {
    pub fn offset(&self) -> i64 {
        let page = self.page.unwrap_or(1).max(1);
        ((page - 1) as i64) * self.limit_val()
    }

    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(50).min(100) as i64
    }
}
