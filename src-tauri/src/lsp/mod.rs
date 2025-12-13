//! LSP Sidecar Infrastructure
//!
//! This module provides infrastructure for running language servers as sidecars
//! and connecting them to the frontend via JSON-RPC over WebSocket.

pub mod manager;

pub use manager::{LspManager, LspServerConfig, LspServerInfo, LspError};
