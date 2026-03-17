use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use thiserror::Error;

/// Git-specific errors with user-friendly messages
#[derive(Debug, Error, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum GitError {
    #[error("Git is not installed on this system")]
    GitNotInstalled,

    #[error("Not a git repository: {path}")]
    NotARepository { path: String },

    #[error("Permission denied: {path}")]
    PermissionDenied { path: String },

    #[error("Git index is locked. Another git process may be running.")]
    IndexLocked,

    #[error("Merge conflicts exist. Resolve conflicts before continuing.")]
    MergeConflicts,

    #[error("Uncommitted changes exist. Commit or stash changes first.")]
    UncommittedChanges,

    #[error("Branch not found: {branch}")]
    BranchNotFound { branch: String },

    #[error("Command failed: {message}")]
    CommandFailed { message: String },

    #[error("Invalid output from git: {message}")]
    ParseError { message: String },

    #[error("Repository ownership issue. Run in terminal: git config --global --add safe.directory \"{path}\"")]
    DubiousOwnership { path: String },

    #[error("Cancelled")]
    Cancelled,
}

impl From<GitError> for String {
    fn from(err: GitError) -> Self {
        err.to_string()
    }
}

// ============================================================================
// Cancellable git process runner
// ============================================================================

struct RunningGitProcess {
    child: Mutex<std::process::Child>,
    cancel_requested: AtomicBool,
}

#[derive(Clone, Default)]
pub struct GitProcessManager {
    processes: Arc<Mutex<HashMap<String, Arc<RunningGitProcess>>>>,
}

impl GitProcessManager {
    fn cancel(&self, op_id: &str) -> bool {
        let proc = {
            let map = self.processes.lock().ok();
            map.and_then(|m| m.get(op_id).cloned())
        };
        if let Some(p) = proc {
            p.cancel_requested.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    fn run_cancellable(
        &self,
        op_id: Option<String>,
        args: Vec<String>,
        cwd: std::path::PathBuf,
    ) -> Result<String, GitError> {
        check_git_installed()?;

        let mut cmd = Command::new("git");
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = cmd.spawn().map_err(|e| GitError::CommandFailed {
            message: e.to_string(),
        })?;

        let running = Arc::new(RunningGitProcess {
            child: Mutex::new(child),
            cancel_requested: AtomicBool::new(false),
        });

        if let Some(id) = op_id.clone() {
            if let Ok(mut map) = self.processes.lock() {
                map.insert(id, running.clone());
            }
        }

        // Take stdout/stderr pipes quickly, without holding the child lock while waiting.
        let (stdout, stderr) = {
            let mut child = running.child.lock().map_err(|_| GitError::CommandFailed {
                message: "Failed to lock process".to_string(),
            })?;
            (child.stdout.take(), child.stderr.take())
        };

        let stdout_handle = std::thread::spawn(move || -> Vec<u8> {
            let mut buf = Vec::new();
            if let Some(mut out) = stdout {
                let _ = out.read_to_end(&mut buf);
            }
            buf
        });

        let stderr_handle = std::thread::spawn(move || -> Vec<u8> {
            let mut buf = Vec::new();
            if let Some(mut err) = stderr {
                let _ = err.read_to_end(&mut buf);
            }
            buf
        });

        // Wait with cancellation support.
        let exit_status = loop {
            if running.cancel_requested.load(Ordering::SeqCst) {
                if let Ok(mut child) = running.child.lock() {
                    let _ = child.kill();
                }
            }

            let maybe_status = {
                let mut child = running.child.lock().map_err(|_| GitError::CommandFailed {
                    message: "Failed to lock process".to_string(),
                })?;
                child.try_wait().map_err(|e| GitError::CommandFailed {
                    message: e.to_string(),
                })?
            };

            if let Some(status) = maybe_status {
                break status;
            }

            std::thread::sleep(Duration::from_millis(25));
        };

        let stdout_bytes = stdout_handle.join().unwrap_or_default();
        let stderr_bytes = stderr_handle.join().unwrap_or_default();
        let stdout_str = String::from_utf8_lossy(&stdout_bytes).to_string();
        let stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();

        if let Some(id) = op_id {
            if let Ok(mut map) = self.processes.lock() {
                map.remove(&id);
            }
        }

        if running.cancel_requested.load(Ordering::SeqCst) {
            return Err(GitError::Cancelled);
        }

        if exit_status.success() {
            return Ok(stdout_str);
        }

        // Map stderr to typed errors for better UX.
        let stderr = stderr_str;
        if stderr.contains("not a git repository") {
            return Err(GitError::NotARepository {
                path: cwd.display().to_string(),
            });
        }
        if stderr.contains("dubious ownership") || stderr.contains("safe.directory") {
            return Err(GitError::DubiousOwnership {
                path: cwd.display().to_string(),
            });
        }
        if stderr.contains("Permission denied") || stderr.contains("permission denied") {
            return Err(GitError::PermissionDenied {
                path: cwd.display().to_string(),
            });
        }
        if stderr.contains("index.lock") || stderr.contains("Unable to create") {
            return Err(GitError::IndexLocked);
        }
        if stderr.contains("CONFLICT") || stderr.contains("Merge conflict") {
            return Err(GitError::MergeConflicts);
        }
        if stderr.contains("uncommitted changes")
            || stderr.contains("local changes")
            || stderr.contains("would be overwritten")
        {
            return Err(GitError::UncommittedChanges);
        }

        Err(GitError::CommandFailed { message: stderr })
    }
}

/// File status in git (porcelain v2 format)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Unmerged,
    TypeChanged,
}

/// A single file change entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>, // For renames
    pub status: FileStatus,
    pub staged: bool,
    pub is_binary: bool,
    pub is_submodule: bool,
}

/// Git repository status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    pub untracked: Vec<GitFileChange>,
    pub conflicted: Vec<GitFileChange>,
    pub has_conflicts: bool,
}

/// Branch information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}

/// Diff hunk for display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub content: String,
}

/// File diff result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub is_binary: bool,
    pub hunks: Vec<DiffHunk>,
    pub additions: u32,
    pub deletions: u32,
    pub truncated: bool, // True if diff was too large and truncated
}

// Helper to check if git is installed (cached with 60s TTL)
// Avoids spawning `git --version` on every single command
fn check_git_installed() -> Result<(), GitError> {
    static CACHE: OnceLock<Mutex<(bool, Instant)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((false, Instant::now() - Duration::from_secs(120))));

    if let Ok(guard) = cache.lock() {
        if guard.0 && guard.1.elapsed() < Duration::from_secs(60) {
            return Ok(());
        }
    }

    let output = Command::new("git").arg("--version").output();
    match output {
        Ok(result) if result.status.success() => {
            if let Ok(mut guard) = cache.lock() {
                *guard = (true, Instant::now());
            }
            Ok(())
        }
        _ => Err(GitError::GitNotInstalled),
    }
}

// Helper to run git command and handle common errors
fn run_git_command(args: &[&str], cwd: &Path) -> Result<String, GitError> {
    check_git_installed()?;

    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| GitError::CommandFailed {
            message: e.to_string(),
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        // Map common git errors to typed errors
        if stderr.contains("not a git repository") {
            return Err(GitError::NotARepository {
                path: cwd.display().to_string(),
            });
        }

        if stderr.contains("dubious ownership") || stderr.contains("safe.directory") {
            return Err(GitError::DubiousOwnership {
                path: cwd.display().to_string(),
            });
        }

        if stderr.contains("Permission denied") || stderr.contains("permission denied") {
            return Err(GitError::PermissionDenied {
                path: cwd.display().to_string(),
            });
        }
        if stderr.contains("index.lock") || stderr.contains("Unable to create") {
            return Err(GitError::IndexLocked);
        }
        if stderr.contains("CONFLICT") || stderr.contains("Merge conflict") {
            return Err(GitError::MergeConflicts);
        }
        if stderr.contains("uncommitted changes")
            || stderr.contains("local changes")
            || stderr.contains("would be overwritten")
        {
            return Err(GitError::UncommittedChanges);
        }

        Err(GitError::CommandFailed { message: stderr })
    }
}

/// Cancel an in-flight git operation by opId.
#[tauri::command]
pub fn git_cancel(op_id: String, manager: tauri::State<'_, GitProcessManager>) -> bool {
    manager.cancel(&op_id)
}

/// Get the current git branch name for a directory
#[tauri::command]
pub fn get_git_branch(path: &str) -> Result<Option<String>, String> {
    let dir = Path::new(path);

    if !dir.exists() {
        return Ok(None);
    }

    // Run git rev-parse to get current branch
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(dir)
        .output();

    match output {
        Ok(result) => {
            if result.status.success() {
                let branch = String::from_utf8_lossy(&result.stdout).trim().to_string();
                if branch.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(branch))
                }
            } else {
                // Not a git repo or git not available
                Ok(None)
            }
        }
        Err(_) => {
            // Git command failed (git not installed, etc.)
            Ok(None)
        }
    }
}

/// Check if a directory is a git repository
#[tauri::command]
pub fn is_git_repo(path: &str) -> bool {
    let git_dir = Path::new(path).join(".git");
    git_dir.exists()
}

/// Get full git status using porcelain v2 format for reliable parsing
#[tauri::command]
pub async fn git_status(
    path: String,
    op_id: Option<String>,
    manager: tauri::State<'_, GitProcessManager>,
) -> Result<GitStatus, GitError> {
    let cwd = std::path::PathBuf::from(&path);
    let args = vec![
        "status".to_string(),
        "--porcelain=v2".to_string(),
        "-z".to_string(),
        "--branch".to_string(),
        "--untracked-files=all".to_string(),
    ];

    let manager = manager.inner().clone();
    let output =
        tauri::async_runtime::spawn_blocking(move || manager.run_cancellable(op_id, args, cwd))
            .await
            .map_err(|e| GitError::CommandFailed {
                message: e.to_string(),
            })??;

    parse_porcelain_v2_status(&output)
}

// Internal, non-cancellable status helper for other backend commands.
// This avoids threading the GitProcessManager state through internal calls.
async fn git_status_internal(path: &str) -> Result<GitStatus, GitError> {
    let dir = Path::new(path);
    let output = run_git_command(
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
        dir,
    )?;
    parse_porcelain_v2_status(&output)
}

/// Parse git status --porcelain=v2 -z output
fn parse_porcelain_v2_status(output: &str) -> Result<GitStatus, GitError> {
    let mut status = GitStatus {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
        conflicted: Vec::new(),
        has_conflicts: false,
    };

    // Split by NUL character
    let entries: Vec<&str> = output.split('\0').filter(|s| !s.is_empty()).collect();
    let mut i = 0;

    while i < entries.len() {
        let entry = entries[i];

        if entry.starts_with("# branch.oid") {
            // Skip OID line
        } else if entry.starts_with("# branch.head") {
            status.branch = entry.strip_prefix("# branch.head ").map(|s| s.to_string());
        } else if entry.starts_with("# branch.upstream") {
            status.upstream = entry
                .strip_prefix("# branch.upstream ")
                .map(|s| s.to_string());
        } else if entry.starts_with("# branch.ab") {
            // Parse ahead/behind: # branch.ab +1 -2
            if let Some(ab) = entry.strip_prefix("# branch.ab ") {
                let parts: Vec<&str> = ab.split_whitespace().collect();
                if parts.len() >= 2 {
                    status.ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                    status.behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
                }
            }
        } else if entry.starts_with("1 ") || entry.starts_with("2 ") {
            // Ordinary changed entry (1) or renamed/copied entry (2)
            let is_rename = entry.starts_with("2 ");
            let parts: Vec<&str> = entry.splitn(if is_rename { 10 } else { 9 }, ' ').collect();

            if parts.len() >= 2 {
                let xy = parts[1]; // XY status codes
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');

                // Get path - for renames, we need the next entry too
                let path = if is_rename && parts.len() >= 10 {
                    parts[9].to_string()
                } else if parts.len() >= 9 {
                    parts[8].to_string()
                } else {
                    continue;
                };

                // For renames, get old path from next NUL-separated entry
                let old_path = if is_rename {
                    i += 1;
                    entries.get(i).map(|s| s.to_string())
                } else {
                    None
                };

                // Check for submodule (submodule state field)
                let is_submodule = parts.get(2).is_some_and(|sub| sub.starts_with('S'));

                // Index (staged) status
                if x != '.' && x != '?' {
                    let file_status = char_to_status(x);
                    status.staged.push(GitFileChange {
                        path: path.clone(),
                        old_path: old_path.clone(),
                        status: file_status,
                        staged: true,
                        is_binary: false, // Will be determined during diff
                        is_submodule,
                    });
                }

                // Worktree (unstaged) status
                if y != '.' && y != '?' {
                    let file_status = char_to_status(y);
                    status.unstaged.push(GitFileChange {
                        path: path.clone(),
                        old_path: old_path.clone(),
                        status: file_status,
                        staged: false,
                        is_binary: false,
                        is_submodule,
                    });
                }
            }
        } else if entry.starts_with("u ") {
            // Unmerged entry
            let parts: Vec<&str> = entry.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                let path = parts[10].to_string();
                status.conflicted.push(GitFileChange {
                    path,
                    old_path: None,
                    status: FileStatus::Unmerged,
                    staged: false,
                    is_binary: false,
                    is_submodule: false,
                });
                status.has_conflicts = true;
            }
        } else if entry.starts_with("? ") {
            // Untracked file
            let path = entry.strip_prefix("? ").unwrap_or("").to_string();
            if !path.is_empty() {
                status.untracked.push(GitFileChange {
                    path,
                    old_path: None,
                    status: FileStatus::Untracked,
                    staged: false,
                    is_binary: false,
                    is_submodule: false,
                });
            }
        } else if entry.starts_with("! ") {
            // Ignored file - we skip these
        }

        i += 1;
    }

    Ok(status)
}

fn char_to_status(c: char) -> FileStatus {
    match c {
        'M' => FileStatus::Modified,
        'T' => FileStatus::TypeChanged,
        'A' => FileStatus::Added,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        'C' => FileStatus::Copied,
        'U' => FileStatus::Unmerged,
        _ => FileStatus::Modified,
    }
}

/// Stage a file (git add)
#[tauri::command]
pub async fn git_stage_file(path: String, file_path: String) -> Result<(), GitError> {
    let dir = Path::new(&path);
    run_git_command(&["add", "--", &file_path], dir)?;
    Ok(())
}

/// Stage all files (git add -A)
#[tauri::command]
pub async fn git_stage_all(path: String) -> Result<(), GitError> {
    let dir = Path::new(&path);
    run_git_command(&["add", "-A"], dir)?;
    Ok(())
}

/// Unstage a file (git reset HEAD)
#[tauri::command]
pub async fn git_unstage_file(path: String, file_path: String) -> Result<(), GitError> {
    let dir = Path::new(&path);
    run_git_command(&["reset", "HEAD", "--", &file_path], dir)?;
    Ok(())
}

/// Unstage all files (git reset HEAD)
#[tauri::command]
pub async fn git_unstage_all(path: String) -> Result<(), GitError> {
    let dir = Path::new(&path);
    run_git_command(&["reset", "HEAD"], dir)?;
    Ok(())
}

/// Commit staged changes
#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, GitError> {
    let dir = Path::new(&path);

    if message.trim().is_empty() {
        return Err(GitError::CommandFailed {
            message: "Commit message cannot be empty".to_string(),
        });
    }

    // Perform commit
    run_git_command(&["commit", "-m", &message], dir)?;

    // Return new HEAD commit hash (more reliable than parsing git commit output)
    let hash = run_git_command(&["rev-parse", "HEAD"], dir)?;
    Ok(hash.trim().to_string())
}

/// Get list of branches
#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<Vec<GitBranch>, GitError> {
    let dir = Path::new(&path);

    // Get local branches with upstream info
    let output = run_git_command(
        &[
            "branch",
            "-a",
            "--format=%(refname:short)|%(HEAD)|%(upstream:short)",
        ],
        dir,
    )?;

    let mut branches = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.is_empty() {
            continue;
        }

        let name = parts[0].trim().to_string();
        if name.is_empty() {
            continue;
        }

        let is_current = parts.get(1).map(|s| s.trim() == "*").unwrap_or(false);
        let upstream = parts
            .get(2)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim().to_string());
        // Remote branches are listed as "remotes/<remote>/<branch>" in `git branch -a`
        let is_remote = name.starts_with("remotes/");

        branches.push(GitBranch {
            name,
            is_current,
            is_remote,
            upstream,
        });
    }

    Ok(branches)
}

/// Switch to a branch
#[tauri::command]
pub async fn git_switch_branch(path: String, branch: String) -> Result<(), GitError> {
    let dir = Path::new(&path);

    // First check for uncommitted changes
    // Check for conflicts and tracked file changes — block those
    // But allow untracked files (standard git behavior)
    let status = git_status_internal(&path).await?;
    if status.has_conflicts || !status.conflicted.is_empty() {
        return Err(GitError::MergeConflicts);
    }
    if !status.staged.is_empty() || !status.unstaged.is_empty() {
        return Err(GitError::UncommittedChanges);
    }

    // Try git switch first (modern), fall back to checkout
    let result = run_git_command(&["switch", &branch], dir);
    if result.is_err() {
        // Try checkout as fallback
        run_git_command(&["checkout", &branch], dir)?;
    }

    Ok(())
}

/// Get diff for a file (staged or unstaged)
#[tauri::command]
pub async fn git_diff_file(
    path: String,
    file_path: String,
    staged: bool,
    op_id: Option<String>,
    manager: tauri::State<'_, GitProcessManager>,
) -> Result<GitDiff, GitError> {
    let cwd = std::path::PathBuf::from(&path);

    // Limit diff output to prevent UI freezes on huge diffs
    const MAX_DIFF_LINES: usize = 5000;

    let args: Vec<String> = if staged {
        vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--".to_string(),
            file_path.clone(),
        ]
    } else {
        vec!["diff".to_string(), "--".to_string(), file_path.clone()]
    };

    let manager = manager.inner().clone();
    let output =
        tauri::async_runtime::spawn_blocking(move || manager.run_cancellable(op_id, args, cwd))
            .await
            .map_err(|e| GitError::CommandFailed {
                message: e.to_string(),
            })??;

    parse_diff_output(&output, &file_path, MAX_DIFF_LINES)
}

fn parse_diff_output(output: &str, file_path: &str, max_lines: usize) -> Result<GitDiff, GitError> {
    let mut diff = GitDiff {
        path: file_path.to_string(),
        old_path: None,
        is_binary: false,
        hunks: Vec::new(),
        additions: 0,
        deletions: 0,
        truncated: false,
    };

    // Check for binary file
    if output.contains("Binary files") || output.contains("GIT binary patch") {
        diff.is_binary = true;
        return Ok(diff);
    }

    let lines: Vec<&str> = output.lines().collect();
    let mut line_count = 0;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut hunk_content = String::new();

    for line in lines {
        if line_count >= max_lines {
            diff.truncated = true;
            break;
        }

        // Parse rename header
        if line.starts_with("rename from ") {
            diff.old_path = line.strip_prefix("rename from ").map(|s| s.to_string());
        }

        // Parse hunk header: @@ -start,count +start,count @@
        if line.starts_with("@@") {
            // Save previous hunk
            if let Some(mut hunk) = current_hunk.take() {
                hunk.content = hunk_content.clone();
                diff.hunks.push(hunk);
                hunk_content.clear();
            }

            // Parse new hunk header
            if let Some(hunk) = parse_hunk_header(line) {
                current_hunk = Some(hunk);
            }
        } else if current_hunk.is_some() {
            // Count additions/deletions
            if line.starts_with('+') && !line.starts_with("+++") {
                diff.additions += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                diff.deletions += 1;
            }

            hunk_content.push_str(line);
            hunk_content.push('\n');
        }

        line_count += 1;
    }

    // Save last hunk
    if let Some(mut hunk) = current_hunk {
        hunk.content = hunk_content;
        diff.hunks.push(hunk);
    }

    Ok(diff)
}

fn parse_hunk_header(line: &str) -> Option<DiffHunk> {
    // Format: @@ -old_start,old_count +new_start,new_count @@ optional context
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }

    let old_range = parts[1].trim_start_matches('-');
    let new_range = parts[2].trim_start_matches('+');

    let (old_start, old_lines) = parse_range(old_range);
    let (new_start, new_lines) = parse_range(new_range);

    Some(DiffHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        content: String::new(),
    })
}

fn parse_range(range: &str) -> (u32, u32) {
    let parts: Vec<&str> = range.split(',').collect();
    let start = parts[0].parse().unwrap_or(1);
    let count = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    (start, count)
}

/// Check if there are uncommitted changes (for branch switch warning)
#[tauri::command]
pub async fn git_has_uncommitted_changes(path: String) -> Result<bool, GitError> {
    let status = git_status_internal(&path).await?;
    Ok(!status.staged.is_empty()
        || !status.unstaged.is_empty()
        || !status.untracked.is_empty()
        || status.has_conflicts
        || !status.conflicted.is_empty())
}

/// Discard changes to a file (git checkout -- file)
#[tauri::command]
pub async fn git_discard_file(path: String, file_path: String) -> Result<(), GitError> {
    let dir = Path::new(&path);
    run_git_command(&["checkout", "--", &file_path], dir)?;
    Ok(())
}
