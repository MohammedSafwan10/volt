//! Chat History Persistence Module
//!
//! Stores AI chat conversations in a local SQLite database.
//! Location: {app_data_dir}/volt/chat_history.db
//!
//! Features:
//! - Create, list, load, update, delete conversations
//! - Pin/unpin conversations
//! - Auto-generate titles from first user message
//! - Full persistence across app restarts

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Database file name
const DB_FILE: &str = "chat_history.db";

/// Conversation summary for list display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i32,
    pub first_user_message: Option<String>,
    pub is_pinned: bool,
    pub mode: String,
}

/// Full conversation with messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_pinned: bool,
    pub mode: String,
    pub messages: Vec<ChatMessage>,
}

/// Individual chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String, // "user" | "assistant" | "tool"
    pub content: String,
    pub timestamp: i64,
    /// JSON-encoded metadata (attachments, tool calls, thinking, etc.)
    pub metadata: Option<String>,
}

/// Managed state for chat history database
pub struct ChatHistoryState {
    db: Mutex<Option<Connection>>,
}

impl Default for ChatHistoryState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
        }
    }
}

/// Get the database path for the app
fn get_db_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure directory exists
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data.join(DB_FILE))
}

/// Initialize the database connection and create tables
fn init_db(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Failed to open database: {}", e))?;

    // Create conversations table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            mode TEXT NOT NULL DEFAULT 'agent',
            message_count INTEGER DEFAULT 0,
            first_user_message TEXT,
            is_pinned INTEGER DEFAULT 0
        )",
        [],
    )
    .map_err(|e| format!("Failed to create conversations table: {}", e))?;

    // Create messages table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            metadata TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )",
        [],
    )
    .map_err(|e| format!("Failed to create messages table: {}", e))?;

    // Create indexes for fast queries
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_conversation 
         ON messages(conversation_id, timestamp)",
        [],
    )
    .map_err(|e| format!("Failed to create messages index: {}", e))?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_updated 
         ON conversations(updated_at DESC)",
        [],
    )
    .map_err(|e| format!("Failed to create conversations index: {}", e))?;

    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON", [])
        .map_err(|e| format!("Failed to enable foreign keys: {}", e))?;

    Ok(conn)
}

/// Ensure database is initialized
fn ensure_db<R: Runtime>(app: &AppHandle<R>, state: &ChatHistoryState) -> Result<(), String> {
    let mut db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;

    if db_guard.is_none() {
        let path = get_db_path(app)?;
        let conn = init_db(&path)?;
        *db_guard = Some(conn);
    }

    Ok(())
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Create a new conversation
#[tauri::command]
pub async fn chat_create_conversation<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    id: String,
    mode: String,
) -> Result<ConversationSummary, String> {
    ensure_db(&app, &state)?;

    let now = chrono::Utc::now().timestamp_millis();

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    conn.execute(
        "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, mode, message_count, is_pinned)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)",
        params![id, "New Chat", now, now, mode],
    ).map_err(|e| format!("Failed to create conversation: {}", e))?;

    Ok(ConversationSummary {
        id,
        title: "New Chat".to_string(),
        created_at: now,
        updated_at: now,
        message_count: 0,
        first_user_message: None,
        is_pinned: false,
        mode,
    })
}

/// List all conversations (summaries only, ordered by updated_at desc)
/// Pinned conversations appear first
#[tauri::command]
pub async fn chat_list_conversations<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
) -> Result<Vec<ConversationSummary>, String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, message_count, first_user_message, is_pinned, mode
         FROM conversations
         ORDER BY is_pinned DESC, updated_at DESC"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                message_count: row.get(4)?,
                first_user_message: row.get(5)?,
                is_pinned: row.get::<_, i32>(6)? != 0,
                mode: row.get(7)?,
            })
        })
        .map_err(|e| format!("Failed to query conversations: {}", e))?;

    let mut conversations = Vec::new();
    for row in rows {
        conversations.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(conversations)
}

/// Load a full conversation with all messages
#[tauri::command]
pub async fn chat_get_conversation<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    conversation_id: String,
) -> Result<Conversation, String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    // Get conversation metadata
    let conv: (String, i64, i64, i32, String) = conn.query_row(
        "SELECT title, created_at, updated_at, is_pinned, mode FROM conversations WHERE id = ?1",
        params![conversation_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|e| format!("Conversation not found: {}", e))?;

    // Get messages
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, timestamp, metadata
         FROM messages
         WHERE conversation_id = ?1
         ORDER BY timestamp ASC",
        )
        .map_err(|e| format!("Failed to prepare messages query: {}", e))?;

    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                timestamp: row.get(3)?,
                metadata: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query messages: {}", e))?;

    let mut messages = Vec::new();
    for row in rows {
        messages.push(row.map_err(|e| format!("Failed to read message: {}", e))?);
    }

    Ok(Conversation {
        id: conversation_id,
        title: conv.0,
        created_at: conv.1,
        updated_at: conv.2,
        is_pinned: conv.3 != 0,
        mode: conv.4,
        messages,
    })
}

/// Save a message to a conversation
#[tauri::command]
pub async fn chat_save_message<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    conversation_id: String,
    message: ChatMessage,
) -> Result<(), String> {
    ensure_db(&app, &state)?;

    let now = chrono::Utc::now().timestamp_millis();

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    // Insert message
    conn.execute(
        "INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            message.id,
            conversation_id,
            message.role,
            message.content,
            message.timestamp,
            message.metadata
        ],
    )
    .map_err(|e| format!("Failed to save message: {}", e))?;

    // Update conversation metadata
    let is_first_user_msg: bool = conn
        .query_row(
            "SELECT first_user_message IS NULL FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if message.role == "user" && is_first_user_msg {
        // Auto-generate title from first user message (first 50 chars)
        let title = if message.content.len() > 50 {
            format!("{}...", &message.content[..50])
        } else {
            message.content.clone()
        };

        conn.execute(
            "UPDATE conversations 
             SET message_count = message_count + 1, 
                 updated_at = ?1, 
                 first_user_message = ?2,
                 title = ?3
             WHERE id = ?4",
            params![now, message.content, title, conversation_id],
        )
        .map_err(|e| format!("Failed to update conversation: {}", e))?;
    } else {
        conn.execute(
            "UPDATE conversations 
             SET message_count = message_count + 1, updated_at = ?1 
             WHERE id = ?2",
            params![now, conversation_id],
        )
        .map_err(|e| format!("Failed to update conversation: {}", e))?;
    }

    Ok(())
}

/// Update conversation title
#[tauri::command]
pub async fn chat_update_title<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    conn.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        params![title, conversation_id],
    )
    .map_err(|e| format!("Failed to update title: {}", e))?;

    Ok(())
}

/// Toggle pin status
#[tauri::command]
pub async fn chat_toggle_pin<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    conversation_id: String,
) -> Result<bool, String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    // Toggle and return new state
    conn.execute(
        "UPDATE conversations SET is_pinned = NOT is_pinned WHERE id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("Failed to toggle pin: {}", e))?;

    let is_pinned: bool = conn
        .query_row(
            "SELECT is_pinned FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get::<_, i32>(0).map(|v| v != 0),
        )
        .map_err(|e| format!("Failed to read pin status: {}", e))?;

    Ok(is_pinned)
}

/// Delete a conversation and all its messages
#[tauri::command]
pub async fn chat_delete_conversation<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    conversation_id: String,
) -> Result<(), String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    // Delete messages first (cascade should handle this but being explicit)
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("Failed to delete messages: {}", e))?;

    // Delete conversation
    conn.execute(
        "DELETE FROM conversations WHERE id = ?1",
        params![conversation_id],
    )
    .map_err(|e| format!("Failed to delete conversation: {}", e))?;

    Ok(())
}

/// Search conversations by content
#[tauri::command]
pub async fn chat_search_conversations<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    query: String,
) -> Result<Vec<ConversationSummary>, String> {
    ensure_db(&app, &state)?;

    if query.trim().is_empty() {
        return chat_list_conversations(app, state).await;
    }

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    let search_pattern = format!("%{}%", query);

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.message_count, 
                c.first_user_message, c.is_pinned, c.mode
         FROM conversations c
         LEFT JOIN messages m ON c.id = m.conversation_id
         WHERE c.title LIKE ?1 OR m.content LIKE ?1
         ORDER BY c.is_pinned DESC, c.updated_at DESC",
        )
        .map_err(|e| format!("Failed to prepare search query: {}", e))?;

    let rows = stmt
        .query_map(params![search_pattern], |row| {
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                message_count: row.get(4)?,
                first_user_message: row.get(5)?,
                is_pinned: row.get::<_, i32>(6)? != 0,
                mode: row.get(7)?,
            })
        })
        .map_err(|e| format!("Failed to search: {}", e))?;

    let mut conversations = Vec::new();
    for row in rows {
        conversations.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(conversations)
}

/// Clear all chat history (dangerous!)
#[tauri::command]
pub async fn chat_clear_all<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
) -> Result<(), String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    conn.execute("DELETE FROM messages", [])
        .map_err(|e| format!("Failed to clear messages: {}", e))?;
    conn.execute("DELETE FROM conversations", [])
        .map_err(|e| format!("Failed to clear conversations: {}", e))?;

    Ok(())
}

/// Truncate a conversation by removing all messages after (and including) a specific message ID
#[tauri::command]
pub async fn chat_truncate_conversation<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ChatHistoryState>,
    conversation_id: String,
    message_id: String,
) -> Result<(), String> {
    ensure_db(&app, &state)?;

    let db_guard = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let conn = db_guard.as_ref().ok_or("Database not initialized")?;

    // Find the timestamp of the target message
    let timestamp: i64 = conn
        .query_row(
            "SELECT timestamp FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![message_id, conversation_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Message not found: {}", e))?;

    // Delete all messages in this conversation that are NEWER than the target message
    // Since we want to revert FROM the user message, we delete it and everything after.
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1 AND timestamp >= ?2",
        params![conversation_id, timestamp],
    )
    .map_err(|e| format!("Failed to truncate conversation: {}", e))?;

    // Update conversation metadata (count and updated_at)
    let count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to update counts: {}", e))?;

    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE conversations SET message_count = ?1, updated_at = ?2 WHERE id = ?3",
        params![count, now, conversation_id],
    )
    .map_err(|e| format!("Failed to update conversation metadata: {}", e))?;

    Ok(())
}
