use serde::Deserialize;

const MAX_PAGE: u32 = 1000;
const MAX_PAGE_SIZE: u32 = 100;

#[derive(Debug, Deserialize)]
pub struct PaginationParams {
    pub page: Option<u32>,
    pub limit: Option<u32>,
}

impl PaginationParams {
    pub fn offset(&self) -> i64 {
        let page = self.page.unwrap_or(1).clamp(1, MAX_PAGE);
        ((page - 1) as i64) * self.limit_val()
    }

    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, MAX_PAGE_SIZE) as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_defaults() {
        let p = PaginationParams {
            page: None,
            limit: None,
        };
        assert_eq!(p.limit_val(), 50);
        assert_eq!(p.offset(), 0);
    }

    #[test]
    fn test_page_1_offset_0() {
        let p = PaginationParams {
            page: Some(1),
            limit: Some(20),
        };
        assert_eq!(p.offset(), 0);
        assert_eq!(p.limit_val(), 20);
    }

    #[test]
    fn test_page_2_offset() {
        let p = PaginationParams {
            page: Some(2),
            limit: Some(20),
        };
        assert_eq!(p.offset(), 20);
    }

    #[test]
    fn test_page_3_offset() {
        let p = PaginationParams {
            page: Some(3),
            limit: Some(25),
        };
        assert_eq!(p.offset(), 50); // (3-1) * 25
    }

    #[test]
    fn test_limit_capped_at_100() {
        let p = PaginationParams {
            page: None,
            limit: Some(500),
        };
        assert_eq!(p.limit_val(), 100);
    }

    #[test]
    fn test_limit_exactly_100() {
        let p = PaginationParams {
            page: None,
            limit: Some(100),
        };
        assert_eq!(p.limit_val(), 100);
    }

    #[test]
    fn test_page_0_treated_as_1() {
        let p = PaginationParams {
            page: Some(0),
            limit: Some(10),
        };
        assert_eq!(p.offset(), 0); // max(0,1) = 1, (1-1)*10 = 0
    }

    #[test]
    fn test_large_page() {
        let p = PaginationParams {
            page: Some(100),
            limit: Some(50),
        };
        assert_eq!(p.offset(), 4950); // (100-1) * 50
    }

    #[test]
    fn test_limit_1() {
        let p = PaginationParams {
            page: Some(5),
            limit: Some(1),
        };
        assert_eq!(p.limit_val(), 1);
        assert_eq!(p.offset(), 4);
    }

    #[test]
    fn extreme_values_are_bounded() {
        let p = PaginationParams {
            page: Some(u32::MAX),
            limit: Some(u32::MAX),
        };
        assert_eq!(p.limit_val(), i64::from(MAX_PAGE_SIZE));
        assert_eq!(
            p.offset(),
            i64::from(MAX_PAGE - 1) * i64::from(MAX_PAGE_SIZE)
        );

        let zero_limit = PaginationParams {
            page: Some(1),
            limit: Some(0),
        };
        assert_eq!(zero_limit.limit_val(), 1);
    }
}
