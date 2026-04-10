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
const LARGE_REPO_FILE_THRESHOLD: usize = 12_000;
const LARGE_REPO_INDEX_MS_THRESHOLD: u64 = 1_500;
const START_FILE_WATCHING_DELAY_MS: u64 = 80;
const START_DART_LSP_DELAY_MS: u64 = 120;
const INIT_GIT_DELAY_MS: u64 = 150;
const INDEX_PROJECT_DELAY_MS: u64 = 450;
const VERIFY_DART_LSP_DELAY_MS: u64 = 1_800;
const LIGHT_DIAGNOSTICS_DELAY_MS: u64 = 1_800;
const LARGE_DIAGNOSTICS_DELAY_MS: u64 = 4_000;
const LIGHT_TSC_DELAY_MS: u64 = 2_600;
const LARGE_TSC_DELAY_MS: u64 = 5_500;
const LIGHT_MCP_DELAY_MS: u64 = 6_000;
const LARGE_MCP_DELAY_MS: u64 = 12_000;
const LIGHT_SEMANTIC_DELAY_MS: u64 = 8_000;
const LARGE_SEMANTIC_DELAY_MS: u64 = 20_000;
const LIGHT_FINALIZE_DELAY_MS: u64 = 3_400;
const LARGE_FINALIZE_DELAY_MS: u64 = 7_800;
const HEAVY_ROOT_DIRS: &[&str] = &["node_modules", ".next", "dist", "build"];

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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActivationPlanRequest {
    pub root_path: String,
    #[serde(default)]
    pub reuse_existing_workspace: bool,
    #[serde(default)]
    pub indexed_count: Option<usize>,
    #[serde(default)]
    pub initial_index_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActivationPlan {
    pub has_heavy_dirs: bool,
    pub is_dart_workspace: bool,
    pub large_repo_mode: bool,
    pub tasks: Vec<WorkspaceActivationTask>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceActivationInspection {
    root_entries: Vec<String>,
    has_pubspec: bool,
    has_analysis_options: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceActivationTaskKind {
    StartFileWatching,
    StartDartLsp,
    InitGit,
    IndexProject,
    RunDiagnostics,
    StartTsc,
    InitializeMcp,
    WarmSemanticIndex,
    FinalizeBackground,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActivationTask {
    pub id: String,
    pub kind: WorkspaceActivationTaskKind,
    pub delay_ms: u64,
    pub phase: String,
    pub serial: bool,
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

    fn inspect_activation(root_path: &str) -> Result<WorkspaceActivationInspection, String> {
        let normalized_root = Self::normalize_path(root_path);
        let read_dir = fs::read_dir(&normalized_root)
            .map_err(|err| format!("Failed to inspect workspace root {normalized_root}: {err}"))?;
        let mut root_entries = Vec::new();

        for entry in read_dir {
            let entry = entry.map_err(|err| {
                format!("Failed to inspect workspace root entry for {normalized_root}: {err}")
            })?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().trim().to_string();
            if !name.is_empty() {
                root_entries.push(name);
            }
        }

        let root = PathBuf::from(&normalized_root);
        Ok(WorkspaceActivationInspection {
            root_entries,
            has_pubspec: root.join("pubspec.yaml").exists(),
            has_analysis_options: root.join("analysis_options.yaml").exists(),
        })
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

impl WorkspaceActivationPlan {
    fn root_has_heavy_dirs(entries: &[String]) -> bool {
        entries.iter().any(|entry| {
            let normalized = entry.trim().to_ascii_lowercase();
            HEAVY_ROOT_DIRS.contains(&normalized.as_str())
        })
    }

    fn from_inspection(
        inspection: WorkspaceActivationInspection,
        request: WorkspaceActivationPlanRequest,
    ) -> Self {
        let has_heavy_dirs = Self::root_has_heavy_dirs(&inspection.root_entries);
        let is_dart_workspace = inspection.has_pubspec || inspection.has_analysis_options;
        let large_repo_mode = has_heavy_dirs
            || request.indexed_count.unwrap_or_default() > LARGE_REPO_FILE_THRESHOLD
            || request.initial_index_duration_ms.unwrap_or_default()
                > LARGE_REPO_INDEX_MS_THRESHOLD;

        let (
            run_diagnostics_delay_ms,
            start_tsc_delay_ms,
            initialize_mcp_delay_ms,
            warm_semantic_index_delay_ms,
            finalize_background_delay_ms,
        ) = if large_repo_mode {
            (
                LARGE_DIAGNOSTICS_DELAY_MS,
                LARGE_TSC_DELAY_MS,
                LARGE_MCP_DELAY_MS,
                LARGE_SEMANTIC_DELAY_MS,
                LARGE_FINALIZE_DELAY_MS,
            )
        } else {
            (
                LIGHT_DIAGNOSTICS_DELAY_MS,
                LIGHT_TSC_DELAY_MS,
                LIGHT_MCP_DELAY_MS,
                LIGHT_SEMANTIC_DELAY_MS,
                LIGHT_FINALIZE_DELAY_MS,
            )
        };

        let mut tasks = Vec::new();
        if request.indexed_count.is_some() || request.initial_index_duration_ms.is_some() {
            if !request.reuse_existing_workspace {
                tasks.push(WorkspaceActivationTask {
                    id: "run-diagnostics".to_string(),
                    kind: WorkspaceActivationTaskKind::RunDiagnostics,
                    delay_ms: run_diagnostics_delay_ms,
                    phase: "heavy-bg".to_string(),
                    serial: true,
                });
                tasks.push(WorkspaceActivationTask {
                    id: "start-tsc".to_string(),
                    kind: WorkspaceActivationTaskKind::StartTsc,
                    delay_ms: start_tsc_delay_ms,
                    phase: "heavy-bg".to_string(),
                    serial: true,
                });
                if is_dart_workspace {
                    tasks.push(WorkspaceActivationTask {
                        id: "verify-dart-lsp".to_string(),
                        kind: WorkspaceActivationTaskKind::StartDartLsp,
                        delay_ms: VERIFY_DART_LSP_DELAY_MS,
                        phase: "heavy-bg".to_string(),
                        serial: true,
                    });
                }
                tasks.push(WorkspaceActivationTask {
                    id: "initialize-mcp".to_string(),
                    kind: WorkspaceActivationTaskKind::InitializeMcp,
                    delay_ms: initialize_mcp_delay_ms,
                    phase: "background-ready".to_string(),
                    serial: true,
                });
                tasks.push(WorkspaceActivationTask {
                    id: "warm-semantic-index".to_string(),
                    kind: WorkspaceActivationTaskKind::WarmSemanticIndex,
                    delay_ms: warm_semantic_index_delay_ms,
                    phase: "background-ready".to_string(),
                    serial: true,
                });
                tasks.push(WorkspaceActivationTask {
                    id: "finalize-background".to_string(),
                    kind: WorkspaceActivationTaskKind::FinalizeBackground,
                    delay_ms: finalize_background_delay_ms,
                    phase: "background-ready".to_string(),
                    serial: true,
                });
            }
        } else {
            if is_dart_workspace {
                tasks.push(WorkspaceActivationTask {
                    id: "start-dart-lsp".to_string(),
                    kind: WorkspaceActivationTaskKind::StartDartLsp,
                    delay_ms: START_DART_LSP_DELAY_MS,
                    phase: "light".to_string(),
                    serial: false,
                });
            }
            tasks.push(WorkspaceActivationTask {
                id: "start-file-watching".to_string(),
                kind: WorkspaceActivationTaskKind::StartFileWatching,
                delay_ms: START_FILE_WATCHING_DELAY_MS,
                phase: "light".to_string(),
                serial: false,
            });
            tasks.push(WorkspaceActivationTask {
                id: "init-git".to_string(),
                kind: WorkspaceActivationTaskKind::InitGit,
                delay_ms: INIT_GIT_DELAY_MS,
                phase: "core-bg".to_string(),
                serial: true,
            });
            tasks.push(WorkspaceActivationTask {
                id: "index-project".to_string(),
                kind: WorkspaceActivationTaskKind::IndexProject,
                delay_ms: INDEX_PROJECT_DELAY_MS,
                phase: "core-bg".to_string(),
                serial: true,
            });
        }

        Self {
            has_heavy_dirs,
            is_dart_workspace,
            large_repo_mode,
            tasks,
        }
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
pub fn workspace_plan_activation(
    request: WorkspaceActivationPlanRequest,
) -> Result<WorkspaceActivationPlan, String> {
    let inspection = WorkspaceManagerState::inspect_activation(&request.root_path)?;
    Ok(WorkspaceActivationPlan::from_inspection(
        inspection, request,
    ))
}

#[tauri::command]
pub async fn workspace_wait_activation_delay(delay_ms: u64) -> Result<(), String> {
    if delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn workspace_close(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceManagerState>,
    request: WorkspaceCloseRequest,
) -> Result<WorkspaceCloseResult, String> {
    state.close_workspace(app, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_plan_marks_large_repo_when_heavy_dirs_are_present() {
        let plan = WorkspaceActivationPlan::from_inspection(
            WorkspaceActivationInspection {
                root_entries: vec!["src".to_string(), "node_modules".to_string()],
                has_pubspec: false,
                has_analysis_options: false,
            },
            WorkspaceActivationPlanRequest {
                root_path: "c:/workspace".to_string(),
                reuse_existing_workspace: false,
                indexed_count: Some(200),
                initial_index_duration_ms: Some(200),
            },
        );

        assert!(plan.has_heavy_dirs);
        assert!(plan.large_repo_mode);
        assert!(plan.tasks.iter().any(|task| {
            task.kind == WorkspaceActivationTaskKind::RunDiagnostics && task.delay_ms == 4_000
        }));
        assert!(plan.tasks.iter().any(|task| {
            task.kind == WorkspaceActivationTaskKind::InitializeMcp && task.delay_ms == 12_000
        }));
        assert!(plan.tasks.iter().any(|task| {
            task.kind == WorkspaceActivationTaskKind::WarmSemanticIndex && task.delay_ms == 20_000
        }));
    }

    #[test]
    fn activation_plan_returns_no_background_tasks_for_reused_workspace() {
        let plan = WorkspaceActivationPlan::from_inspection(
            WorkspaceActivationInspection {
                root_entries: vec!["src".to_string()],
                has_pubspec: true,
                has_analysis_options: false,
            },
            WorkspaceActivationPlanRequest {
                root_path: "c:/workspace".to_string(),
                reuse_existing_workspace: true,
                indexed_count: Some(20),
                initial_index_duration_ms: Some(50),
            },
        );

        assert!(plan.is_dart_workspace);
        assert!(plan.tasks.is_empty());
    }
}
