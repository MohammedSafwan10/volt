use std::path::Path;
use std::process::Command;

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
                let branch = String::from_utf8_lossy(&result.stdout)
                    .trim()
                    .to_string();
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
