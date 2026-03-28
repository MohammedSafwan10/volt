use bytes::Bytes;
use futures::StreamExt;
use keyring::Entry;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::ipc::Channel;

const KEYRING_SERVICE: &str = "volt";

/// Shared HTTP client with timeout and connection pooling.
/// Using OnceLock ensures a single instance is created on first use.
/// This avoids creating a new client per request (wastes connections)
/// and ensures all requests have a timeout (prevents infinite hangs).
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(5)
            .build()
            .expect("Failed to create HTTP client")
    })
}

/// Validate model name to prevent URL path injection.
/// Only allows alphanumeric chars, dots, hyphens, underscores, and colons.
fn validate_model_name(model: &str) -> Result<(), String> {
    if model.is_empty() {
        return Err("Model name cannot be empty".to_string());
    }
    if model.len() > 128 {
        return Err("Model name too long".to_string());
    }
    if !model
        .chars()
        .all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ':' || c == '/')
    {
        return Err(format!("Invalid model name: {}", model));
    }
    // Reject path traversal attempts
    if model.contains("..") {
        return Err("Invalid model name: contains '..'".to_string());
    }
    Ok(())
}

/// Resolve an API key: prefer the IPC-passed key, fall back to keyring.
/// This allows the frontend to gradually stop sending keys over IPC.
fn resolve_api_key(ipc_key: &str, provider: &str) -> Result<String, String> {
    let trimmed = ipc_key.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    let entry = keyring_entry(provider)?;
    match entry.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(key),
        Ok(_) => Err(format!("No API key configured for {provider}")),
        Err(keyring::Error::NoEntry) => Err(format!("No API key configured for {provider}")),
        Err(e) => Err(format!("Failed to read API key for {provider}: {e}")),
    }
}

fn provider_keyring_username(provider: &str) -> Result<String, String> {
    match provider {
        "gemini" => Ok("ai.gemini.api_key".to_string()),
        "openrouter" => Ok("ai.openrouter.api_key".to_string()),
        "anthropic" => Ok("ai.anthropic.api_key".to_string()),
        "openai" => Ok("ai.openai.api_key".to_string()),
        "mistral" => Ok("ai.mistral.api_key".to_string()),
        _ => Err("Unsupported AI provider".to_string()),
    }
}

fn keyring_entry(provider: &str) -> Result<Entry, String> {
    let username = provider_keyring_username(provider)?;
    Entry::new(KEYRING_SERVICE, &username)
        .map_err(|_| "Failed to access secure storage".to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn ai_set_api_key(provider: String, api_key: String) -> Result<(), String> {
    let entry = keyring_entry(&provider)?;
    entry
        .set_password(&api_key)
        .map_err(|err| format!("Failed to save API key: {err}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn ai_has_api_key(provider: String) -> Result<bool, String> {
    let entry = keyring_entry(&provider)?;

    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(err) => {
            if matches!(err, keyring::Error::NoEntry) {
                Ok(false)
            } else {
                Err(format!("Failed to check API key: {err}"))
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn ai_remove_api_key(provider: String) -> Result<(), String> {
    let entry = keyring_entry(&provider)?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(err) => {
            if matches!(err, keyring::Error::NoEntry) {
                Ok(())
            } else {
                Err(format!("Failed to remove API key: {err}"))
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ai_validate_api_key(provider: String) -> Result<bool, String> {
    let provider = provider.trim().to_ascii_lowercase();

    if !ai_has_api_key(provider.clone())? {
        return Err(format!("No API key configured for {provider}"));
    }

    match provider.as_str() {
        "gemini" => {
            validate_model_name("gemini-2.5-flash")?;
            let client = shared_http_client();
            let api_key = resolve_api_key("", "gemini")?;
            let response = client
                .post("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent")
                .header("x-goog-api-key", &api_key)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({
                    "contents": [{ "parts": [{ "text": "Hi" }] }],
                    "generationConfig": { "maxOutputTokens": 5 }
                }))
                .send()
                .await
                .map_err(|err| format!("Failed to reach Gemini: {err}"))?;

            if response.status().is_success() {
                Ok(true)
            } else {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                Err(format!(
                    "Gemini validation failed (Status {status}): {text}"
                ))
            }
        }
        "openrouter" => {
            let _ = openrouter_proxy(
                serde_json::json!({
                    "model": "qwen/qwen3-coder:free",
                    "max_tokens": 1,
                    "messages": [{ "role": "user", "content": "Hi" }]
                }),
                String::new(),
            )
            .await?;
            Ok(true)
        }
        "anthropic" => {
            let _ = anthropic_proxy(
                serde_json::json!({
                    "model": "claude-opus-4-6",
                    "max_tokens": 1,
                    "messages": [{ "role": "user", "content": "Hi" }]
                }),
                String::new(),
                "2023-06-01".to_string(),
            )
            .await?;
            Ok(true)
        }
        "openai" => {
            let _ = openai_proxy(
                serde_json::json!({
                    "model": "gpt-5.4",
                    "max_completion_tokens": 1,
                    "messages": [{ "role": "user", "content": "Hi" }]
                }),
                String::new(),
            )
            .await?;
            Ok(true)
        }
        "mistral" => {
            let _ = mistral_proxy(
                serde_json::json!({
                    "model": "devstral-medium-latest",
                    "max_tokens": 1,
                    "messages": [{ "role": "user", "content": "Hi" }]
                }),
                String::new(),
            )
            .await?;
            Ok(true)
        }
        _ => Err("Unsupported AI provider".to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn anthropic_proxy(
    body: Value,
    api_key: String,
    anthropic_version: String,
) -> Result<Value, String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "anthropic")?;
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", anthropic_version)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to send request to Anthropic: {err}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Anthropic response: {err}"))?;

    let json: Value = serde_json::from_str(&text).map_err(|err| {
        format!("Failed to parse Anthropic JSON (Status {status}): {err}\nResponse: {text}")
    })?;

    if !status.is_success() {
        return Err(format!("Anthropic API error (Status {status}): {text}"));
    }

    Ok(json)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn anthropic_proxy_stream(
    body: Value,
    api_key: String,
    anthropic_version: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "anthropic")?;
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", anthropic_version)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to send streaming request to Anthropic: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "Anthropic streaming error (Status {status}): {text}"
        ));
    }

    let mut stream = response.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk: Bytes =
            item.map_err(|err| format!("Error while reading Anthropic stream: {err}"))?;
        let text = String::from_utf8_lossy(&chunk).to_string();

        on_event
            .send(text)
            .map_err(|err| format!("Failed to send chunk to frontend: {err}"))?;
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn openai_proxy(body: Value, api_key: String) -> Result<Value, String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "openai")?;

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to reach OpenAI: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI error (Status {status}): {text}"));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse OpenAI response: {err}"))?;

    Ok(json)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn openai_proxy_stream(
    body: Value,
    api_key: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "openai")?;

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to send streaming request to OpenAI: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI streaming error (Status {status}): {text}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| format!("Error while reading OpenAI stream: {err}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some(i) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=i).collect();
            if let Ok(line) = String::from_utf8(line_bytes) {
                if !line.trim().is_empty() {
                    on_event
                        .send(line)
                        .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
                }
            }
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        if !line.trim().is_empty() {
            on_event
                .send(line)
                .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
        }
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn openrouter_proxy(body: Value, api_key: String) -> Result<Value, String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "openrouter")?;

    let response = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://volt.dev")
        .header("X-Title", "Volt IDE")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to reach OpenRouter: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("OpenRouter error (Status {status}): {text}"));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse OpenRouter response: {err}"))?;

    Ok(json)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn openrouter_proxy_stream(
    body: Value,
    api_key: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "openrouter")?;

    let response = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("HTTP-Referer", "https://volt.dev")
        .header("X-Title", "Volt IDE")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to send streaming request to OpenRouter: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "OpenRouter streaming error (Status {status}): {text}"
        ));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| format!("Error while reading OpenRouter stream: {err}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some(i) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=i).collect();
            if let Ok(line) = String::from_utf8(line_bytes) {
                if !line.trim().is_empty() {
                    on_event
                        .send(line)
                        .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
                }
            }
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        if !line.trim().is_empty() {
            on_event
                .send(line)
                .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
        }
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn gemini_proxy(body: Value, api_key: String, model: String) -> Result<Value, String> {
    validate_model_name(&model)?;
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "gemini")?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );

    let response = client
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to reach Gemini: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Gemini error (Status {status}): {text}"));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse Gemini response: {err}"))?;

    Ok(json)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn gemini_proxy_stream(
    body: Value,
    api_key: String,
    model: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    validate_model_name(&model)?;
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "gemini")?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse",
        model
    );

    let response = client
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to send streaming request to Gemini: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Gemini streaming error (Status {status}): {text}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| format!("Error while reading Gemini stream: {err}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some(i) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=i).collect();
            if let Ok(line) = String::from_utf8(line_bytes) {
                if !line.trim().is_empty() {
                    on_event
                        .send(line)
                        .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
                }
            }
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        if !line.trim().is_empty() {
            on_event
                .send(line)
                .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
        }
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mistral_proxy(body: Value, api_key: String) -> Result<Value, String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "mistral")?;

    let response = client
        .post("https://api.mistral.ai/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to reach Mistral: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Mistral error (Status {status}): {text}"));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse Mistral response: {err}"))?;

    Ok(json)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mistral_proxy_stream(
    body: Value,
    api_key: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let client = shared_http_client();
    let api_key = resolve_api_key(&api_key, "mistral")?;

    let response = client
        .post("https://api.mistral.ai/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Failed to send streaming request to Mistral: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Mistral streaming error (Status {status}): {text}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| format!("Error while reading Mistral stream: {err}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some(i) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=i).collect();
            if let Ok(line) = String::from_utf8(line_bytes) {
                if !line.trim().is_empty() {
                    on_event
                        .send(line)
                        .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
                }
            }
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        if !line.trim().is_empty() {
            on_event
                .send(line)
                .map_err(|err| format!("Failed to send line to frontend: {err}"))?;
        }
    }

    Ok(())
}
