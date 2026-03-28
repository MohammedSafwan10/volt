use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::file_ops::get_file_info;
use crate::commands::mcp::stop_all_mcp_servers;
use crate::commands::terminal::terminal_kill_all;
use crate::commands::{
    file_index::clear_index_cache, git::GitProcessManager, lsp::LspManagerState,
};
use crate::domains::file_system::watch::FileWatchState;
use crate::observability::{debug_log, DebugScope};

const WORKSPACE_EVENT: &str = "workspace://lifecycle";
const WORKSPACE_STATE_FILE: &str = "workspace-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub active_root_path: Option<String>,
    pub persisted_root_path: Option<String>,
    pub recent_projects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceLifecycleStage {
    Opening,
    Opened,
    OpenFailed,
    Closing,
    Closed,
    Refreshed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLifecycleEvent {
    pub stage: WorkspaceLifecycleStage,
    pub active_root_path: Option<String>,
    pub target_root_path: Option<String>,
    pub previous_root_path: Option<String>,
    pub recent_projects: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenRequest {
    pub path: String,
    pub current_root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenResult {
    pub opened: bool,
    pub active_root_path: Option<String>,
    pub previous_root_path: Option<String>,
    pub unchanged: bool,
    pub recent_projects: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCloseRequest {
    pub current_root_path: Option<String>,
    #[serde(default)]
    pub remove_persistence: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCloseResult {
    pub closed: bool,
    pub active_root_path: Option<String>,
    pub previous_root_path: Option<String>,
    pub recent_projects: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRefreshRequest {
    pub current_root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRefreshResult {
    pub refreshed: bool,
    pub active_root_path: Option<String>,
    pub recent_projects: Vec<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct WorkspaceManagerState {
    inner: Mutex<WorkspaceState>,
}

impl WorkspaceManagerState {
    const MAX_RECENT_PROJECTS: usize = 10;

    fn normalize_path(path: &str) -> String {
        path.replace('\\', "/")
    }

    fn emit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        stage: WorkspaceLifecycleStage,
        target_root_path: Option<String>,
        previous_root_path: Option<String>,
        message: Option<String>,
    ) {
        let snapshot = self.snapshot();
        let _ = app.emit(
            WORKSPACE_EVENT,
            WorkspaceLifecycleEvent {
                stage,
                active_root_path: snapshot.active_root_path,
                target_root_path,
                previous_root_path,
                recent_projects: snapshot.recent_projects,
                message,
            },
        );
    }

    pub fn snapshot(&self) -> WorkspaceState {
        self.inner
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| WorkspaceState {
                active_root_path: None,
                persisted_root_path: None,
                recent_projects: Vec::new(),
            })
    }

    fn set_workspace_paths(
        &self,
        active_root_path: Option<String>,
        persisted_root_path: Option<String>,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|err| format!("Failed to acquire workspace state lock: {err}"))?;
        state.active_root_path = active_root_path;
        state.persisted_root_path = persisted_root_path;
        Ok(())
    }

    fn add_recent_project(&self, root_path: &str) -> Result<Vec<String>, String> {
        let normalized = Self::normalize_path(root_path);
        let mut state = self
            .inner
            .lock()
            .map_err(|err| format!("Failed to acquire workspace state lock: {err}"))?;

        let mut deduped = Vec::with_capacity(Self::MAX_RECENT_PROJECTS);
        deduped.push(normalized.clone());
        for existing in state.recent_projects.iter() {
            if existing != &normalized && deduped.len() < Self::MAX_RECENT_PROJECTS {
                deduped.push(existing.clone());
            }
        }
        state.recent_projects = deduped.clone();
        Ok(deduped)
    }

    fn state_file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("Failed to resolve app data dir: {err}"))?;
        fs::create_dir_all(&dir).map_err(|err| format!("Failed to create app data dir: {err}"))?;
        Ok(dir.join(WORKSPACE_STATE_FILE))
    }

    fn read_persisted_state<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<WorkspaceState, String> {
        let path = Self::state_file_path(app)?;
        if !path.exists() {
            return Ok(WorkspaceState::default());
        }
        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read workspace state: {err}"))?;
        serde_json::from_str::<WorkspaceState>(&raw)
            .map_err(|err| format!("Failed to parse workspace state: {err}"))
    }

    fn persist_state<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let path = Self::state_file_path(app)?;
        let snapshot = self.snapshot();
        let raw = serde_json::to_string(&snapshot)
            .map_err(|err| format!("Failed to serialize workspace state: {err}"))?;
        fs::write(path, raw).map_err(|err| format!("Failed to write workspace state: {err}"))
    }

    fn hydrate_from_disk<R: Runtime>(&self, app: &AppHandle<R>) -> Result<WorkspaceState, String> {
        let persisted = self.read_persisted_state(app)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|err| format!("Failed to acquire workspace state lock: {err}"))?;

        if state.active_root_path.is_none() {
            state.active_root_path = persisted.active_root_path.clone();
        }
        if state.persisted_root_path.is_none() {
            state.persisted_root_path = persisted.persisted_root_path.clone();
        }
        if state.recent_projects.is_empty() {
            state.recent_projects = persisted.recent_projects.clone();
        }

        Ok(state.clone())
    }

    pub fn replace_recent_projects(
        &self,
        recent_projects: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|err| format!("Failed to acquire workspace state lock: {err}"))?;

        let mut seen = HashSet::new();
        let mut deduped = Vec::new();
        for path in recent_projects {
            let normalized = Self::normalize_path(&path);
            if seen.insert(normalized.clone()) {
                deduped.push(normalized);
            }
            if deduped.len() >= Self::MAX_RECENT_PROJECTS {
                break;
            }
        }

        state.recent_projects = deduped.clone();
        Ok(deduped)
    }

    async fn validate_workspace(path: &str) -> bool {
        get_file_info(Self::normalize_path(path)).await.is_ok()
    }

    pub async fn open_workspace<R: Runtime>(
        &self,
        app: AppHandle<R>,
        request: WorkspaceOpenRequest,
    ) -> Result<WorkspaceOpenResult, String> {
        let _scope = DebugScope::new("workspace", format!("open {}", request.path));
        let target_root_path = Self::normalize_path(&request.path);
        let snapshot = self.snapshot();
        let previous_root_path = request
            .current_root_path
            .map(|path| Self::normalize_path(&path))
            .or_else(|| snapshot.active_root_path.clone());

        if previous_root_path.as_deref() == Some(target_root_path.as_str()) {
            return Ok(WorkspaceOpenResult {
                opened: true,
                active_root_path: snapshot.active_root_path,
                previous_root_path,
                unchanged: true,
                recent_projects: snapshot.recent_projects,
                message: None,
            });
        }

        self.emit(
            &app,
            WorkspaceLifecycleStage::Opening,
            Some(target_root_path.clone()),
            previous_root_path.clone(),
            None,
        );

        if !Self::validate_workspace(&target_root_path).await {
            self.emit(
                &app,
                WorkspaceLifecycleStage::OpenFailed,
                Some(target_root_path.clone()),
                previous_root_path.clone(),
                Some(format!("Failed to open folder: {target_root_path}")),
            );
            let snapshot = self.snapshot();
            return Ok(WorkspaceOpenResult {
                opened: false,
                active_root_path: snapshot.active_root_path,
                previous_root_path,
                unchanged: false,
                recent_projects: snapshot.recent_projects,
                message: Some(format!("Failed to open folder: {target_root_path}")),
            });
        }

        self.set_workspace_paths(
            Some(target_root_path.clone()),
            Some(target_root_path.clone()),
        )?;
        let recent_projects = self.add_recent_project(&target_root_path)?;
        let _ = self.persist_state(&app);
        self.emit(
            &app,
            WorkspaceLifecycleStage::Opened,
            Some(target_root_path.clone()),
            previous_root_path.clone(),
            None,
        );

        Ok(WorkspaceOpenResult {
            opened: true,
            active_root_path: Some(target_root_path),
            previous_root_path,
            unchanged: false,
            recent_projects,
            message: None,
        })
    }

    pub async fn refresh_workspace<R: Runtime>(
        &self,
        app: AppHandle<R>,
        request: WorkspaceRefreshRequest,
    ) -> Result<WorkspaceRefreshResult, String> {
        let _scope = DebugScope::new("workspace", "refresh");
        let current_root_path = request
            .current_root_path
            .map(|path| Self::normalize_path(&path));
        let snapshot = self.snapshot();
        let active_root_path = current_root_path
            .or_else(|| snapshot.active_root_path.clone())
            .or_else(|| snapshot.persisted_root_path.clone());
        let Some(active_root_path) = active_root_path else {
            return Ok(WorkspaceRefreshResult {
                refreshed: false,
                active_root_path: snapshot.active_root_path,
                recent_projects: snapshot.recent_projects,
                message: None,
            });
        };

        if !Self::validate_workspace(&active_root_path).await {
            self.emit(
                &app,
                WorkspaceLifecycleStage::OpenFailed,
                Some(active_root_path.clone()),
                Some(active_root_path.clone()),
                Some(format!("Failed to refresh folder: {active_root_path}")),
            );
            let snapshot = self.snapshot();
            return Ok(WorkspaceRefreshResult {
                refreshed: false,
                active_root_path: snapshot.active_root_path,
                recent_projects: snapshot.recent_projects,
                message: Some(format!("Failed to refresh folder: {active_root_path}")),
            });
        }

        self.emit(
            &app,
            WorkspaceLifecycleStage::Refreshed,
            Some(active_root_path.clone()),
            Some(active_root_path.clone()),
            None,
        );
        let snapshot = self.snapshot();
        Ok(WorkspaceRefreshResult {
            refreshed: true,
            active_root_path: Some(active_root_path),
            recent_projects: snapshot.recent_projects,
            message: None,
        })
    }

    pub async fn close_workspace(
        &self,
        app: AppHandle,
        request: WorkspaceCloseRequest,
    ) -> Result<WorkspaceCloseResult, String> {
        let _scope = DebugScope::new("workspace", "close");
        let previous_root_path = request
            .current_root_path
            .map(|path| Self::normalize_path(&path));
        let state_before_close = self.snapshot();
        self.emit(
            &app,
            WorkspaceLifecycleStage::Closing,
            None,
            previous_root_path.clone(),
            None,
        );

        if let Some(root_path) = previous_root_path.as_deref() {
            let file_index_state: tauri::State<'_, crate::commands::file_index::FileIndexState> =
                app.state();
            let _ =
                clear_index_cache(file_index_state, app.clone(), Some(root_path.to_string())).await;
            let _ = terminal_kill_all();

            {
                let lsp_state: tauri::State<'_, LspManagerState<tauri::Wry>> = app.state();
                let manager_guard = lsp_state.0.lock();
                if let Ok(guard) = manager_guard {
                    if let Some(ref manager) = *guard {
                        let _ = manager.stop_all();
                    }
                }
            }

            {
                let watch_state: tauri::State<'_, FileWatchState> = app.state();
                let _ = watch_state.stop(root_path);
            }

            {
                let git_state: tauri::State<'_, GitProcessManager> = app.state();
                git_state.cancel_all();
            }

            let _ = stop_all_mcp_servers(app.clone()).await;
            debug_log(
                "workspace",
                format!("closed background services for {}", root_path),
            );
        }

        let next_active_root_path = if state_before_close.active_root_path == previous_root_path {
            None
        } else {
            state_before_close.active_root_path.clone()
        };
        let next_persisted_root_path = if request.remove_persistence {
            None
        } else {
            state_before_close
                .persisted_root_path
                .clone()
                .or(previous_root_path.clone())
        };
        self.set_workspace_paths(next_active_root_path, next_persisted_root_path)?;
        let _ = self.persist_state(&app);
        self.emit(
            &app,
            WorkspaceLifecycleStage::Closed,
            None,
            previous_root_path.clone(),
            None,
        );

        let snapshot = self.snapshot();
        Ok(WorkspaceCloseResult {
            closed: true,
            active_root_path: snapshot.active_root_path,
            previous_root_path,
            recent_projects: snapshot.recent_projects,
        })
    }
}

#[tauri::command]
pub fn workspace_get_state(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceManagerState>,
) -> Result<WorkspaceState, String> {
    state.hydrate_from_disk(&app)
}

#[tauri::command]
pub fn workspace_replace_recent_projects(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceManagerState>,
    recent_projects: Vec<String>,
) -> Result<Vec<String>, String> {
    let replaced = state.replace_recent_projects(recent_projects)?;
    let _ = state.persist_state(&app);
    Ok(replaced)
}

#[tauri::command]
pub async fn workspace_open<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, WorkspaceManagerState>,
    request: WorkspaceOpenRequest,
) -> Result<WorkspaceOpenResult, String> {
    state.open_workspace(app, request).await
}

#[tauri::command]
pub async fn workspace_refresh<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, WorkspaceManagerState>,
    request: WorkspaceRefreshRequest,
) -> Result<WorkspaceRefreshResult, String> {
    state.refresh_workspace(app, request).await
}

#[tauri::command]
pub async fn workspace_close(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceManagerState>,
    request: WorkspaceCloseRequest,
) -> Result<WorkspaceCloseResult, String> {
    state.close_workspace(app, request).await
}
