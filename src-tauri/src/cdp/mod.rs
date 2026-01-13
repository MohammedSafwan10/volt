//! CDP (Chrome DevTools Protocol) Module
//! 
//! Provides professional browser automation capabilities similar to Playwright/Puppeteer.
//! Uses chromiumoxide to connect to WebView2's CDP endpoint.
//!
//! Features:
//! - Console log capture (Runtime.consoleAPICalled)
//! - Error capture (Runtime.exceptionThrown)
//! - Network monitoring (Network.*)
//! - DOM inspection (DOM.*)
//! - Browser automation (Input.*, Page.*)
//! - Screenshots (Page.captureScreenshot)

pub mod manager;
pub mod types;
pub mod commands;
