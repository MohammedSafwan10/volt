// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Enable CDP (Chrome DevTools Protocol) for WebView2 on Windows
    // This MUST be set BEFORE any WebView2 instance is created.
    // Restrict to debug builds and localhost-only origins.
    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-port=9222 --remote-allow-origins=http://localhost:1420,http://127.0.0.1:1420,https://localhost:1420,https://127.0.0.1:1420",
        );
    }

    volt_lib::run()
}
