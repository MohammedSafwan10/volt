use std::time::Instant;

pub fn debug_log(topic: &str, message: impl AsRef<str>) {
    #[cfg(debug_assertions)]
    {
        eprintln!("[VoltDebug][{topic}] {}", message.as_ref());
    }
}

#[tauri::command]
pub fn debug_log_frontend(topic: String, message: String) {
    debug_log(&topic, message);
}

pub struct DebugScope {
    topic: &'static str,
    action: String,
    started_at: Instant,
}

impl DebugScope {
    pub fn new(topic: &'static str, action: impl Into<String>) -> Self {
        let action = action.into();
        debug_log(topic, format!("start {action}"));
        Self {
            topic,
            action,
            started_at: Instant::now(),
        }
    }

    pub fn checkpoint(&self, message: impl AsRef<str>) {
        debug_log(
            self.topic,
            format!(
                "{} +{}ms {}",
                self.action,
                self.started_at.elapsed().as_millis(),
                message.as_ref()
            ),
        );
    }
}

impl Drop for DebugScope {
    fn drop(&mut self) {
        debug_log(
            self.topic,
            format!(
                "done {} in {}ms",
                self.action,
                self.started_at.elapsed().as_millis()
            ),
        );
    }
}
