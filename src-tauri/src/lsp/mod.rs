//! LSP Sidecar Infrastructure
//!
//! This module provides infrastructure for running language servers as sidecars
//! (bundled with app) or external servers (from user's PATH like Dart, Rust Analyzer)
//! and connecting them to the frontend via JSON-RPC over WebSocket.

pub mod manager;

pub use manager::{ExternalLspConfig, LspError, LspManager, LspServerConfig, LspServerInfo};
