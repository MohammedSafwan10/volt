// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Enable CDP (Chrome DevTools Protocol) for WebView2 on Windows
    // This MUST be set BEFORE any WebView2 instance is created
    // CDP allows professional browser automation like Playwright/Puppeteer
    #[cfg(target_os = "windows")]
    {
        // Use a fixed port for CDP - this makes it easier to connect
        // The WebSocket URL will be: ws://127.0.0.1:9222/devtools/browser/<id>
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-port=9222 --remote-allow-origins=*"
        );
    }

    volt_lib::run()
}
