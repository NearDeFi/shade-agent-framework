//! # Sandbox Tests
//!
//! Integration tests that run against a real NEAR sandbox environment.
//! These tests verify end-to-end functionality, cross-contract calls,
//! state persistence, and real blockchain behavior.

mod helpers;

// Test modules
mod lifecycle_tests;
mod cross_contract_tests;
mod codehash_management_tests;
mod owner_operations_tests;
mod edge_cases_tests;
