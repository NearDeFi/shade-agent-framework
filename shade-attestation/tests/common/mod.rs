//! Shared test data and helpers for integration tests.
//! Paths are relative to this file (tests/common/mod.rs).

pub const TEST_TCB_INFO_STRING: &str = include_str!("../../assets/tcb_info.json");
pub const TEST_APP_COMPOSE_STRING: &str = include_str!("../../assets/app_compose.json");
pub const TEST_APP_COMPOSE_WITH_SERVICES_STRING: &str =
    include_str!("../../assets/app_compose_with_services.json");
pub const TEST_LAUNCHER_IMAGE_COMPOSE_STRING: &str =
    include_str!("../../assets/launcher_image_compose.yaml");

/// Returns collateral JSON as a serde_json::Value for tests that need to mutate or parse it.
pub fn collateral() -> serde_json::Value {
    let s = include_str!("../../assets/collateral.json");
    s.parse().expect("collateral.json is valid JSON")
}
