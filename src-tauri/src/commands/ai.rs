use keyring::Entry;

const KEYRING_SERVICE: &str = "volt";

fn provider_keyring_username(provider: &str) -> Result<String, String> {
    match provider {
        "gemini" => Ok("ai.gemini.api_key".to_string()),
        _ => Err("Unsupported AI provider".to_string()),
    }
}

fn keyring_entry(provider: &str) -> Result<Entry, String> {
    let username = provider_keyring_username(provider)?;
    Entry::new(KEYRING_SERVICE, &username).map_err(|_| "Failed to access secure storage".to_string())
}

#[tauri::command]
pub fn ai_set_api_key(provider: String, api_key: String) -> Result<(), String> {
    let entry = keyring_entry(&provider)?;
    entry
        .set_password(&api_key)
    .map_err(|err| format!("Failed to save API key: {err}"))
}

#[tauri::command]
pub fn ai_get_api_key(provider: String) -> Result<Option<String>, String> {
    let entry = keyring_entry(&provider)?;

    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(err) => {
            // Avoid exposing platform-specific error strings to the UI.
            // If the entry doesn't exist, treat it as "no key configured".
            if matches!(err, keyring::Error::NoEntry) {
                Ok(None)
            } else {
                Err(format!("Failed to read API key: {err}"))
            }
        }
    }
}

#[tauri::command]
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

#[tauri::command]
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
