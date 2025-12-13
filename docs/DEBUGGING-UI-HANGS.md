# Debugging UI Hangs in Tauri + Svelte 5 Apps

This document covers common causes of UI freezes/hangs and how to fix them.

## Common Causes

### 1. Svelte 5 `$state` Array Mutations

**Problem:** Using `push()`, `splice()`, or other mutating methods on `$state` arrays doesn't trigger reactivity properly, causing infinite loops or stale UI.

**Bad:**
```typescript
class Store {
  items = $state<Item[]>([]);
  
  addItem(item: Item) {
    this.items.push(item);  // ❌ Mutation not detected
  }
  
  removeItem(id: string) {
    const idx = this.items.findIndex(i => i.id === id);
    this.items.splice(idx, 1);  // ❌ Mutation not detected
  }
}
```

**Good:**
```typescript
class Store {
  items = $state<Item[]>([]);
  
  addItem(item: Item) {
    this.items = [...this.items, item];  // ✅ New array triggers reactivity
  }
  
  removeItem(id: string) {
    this.items = this.items.filter(i => i.id !== id);  // ✅ New array
  }
}
```

### 2. `$effect` with Non-Reactive Variables

**Problem:** Using regular `let` variables in `$effect` conditions doesn't work - the effect won't re-run when the variable changes.

**Bad:**
```typescript
let initialized = false;  // ❌ Not reactive

$effect(() => {
  if (active && !initialized) {  // Effect won't see initialized change
    doInit().then(() => { initialized = true; });
  }
});
```

**Good:**
```typescript
let initialized = $state(false);  // ✅ Reactive

$effect(() => {
  if (active && !initialized) {
    doInit().then(() => { initialized = true; });
  }
});
```

### 3. Race Conditions in Async Effects

**Problem:** `$effect` can re-run before async operations complete, causing multiple simultaneous calls.

**Bad:**
```typescript
$effect(() => {
  if (shouldInit) {
    void initAsync();  // ❌ Can be called multiple times
  }
});
```

**Good:**
```typescript
let initializing = false;

async function tryInit() {
  if (initializing) return;  // ✅ Guard against concurrent calls
  initializing = true;
  try {
    await initAsync();
  } finally {
    initializing = false;
  }
}

$effect(() => {
  if (shouldInit) {
    void tryInit();
  }
});
```

### 4. Blocking Rust Commands

**Problem:** Synchronous Tauri commands block the UI thread.

**Bad (Rust):**
```rust
#[tauri::command]
fn slow_operation() -> Result<Data, Error> {
    // This blocks the UI!
    std::thread::sleep(Duration::from_secs(5));
    Ok(data)
}
```

**Good (Rust):**
```rust
#[tauri::command]
async fn slow_operation() -> Result<Data, Error> {
    // Run blocking work in separate thread
    tokio::task::spawn_blocking(|| {
        // Heavy work here
    }).await?
}
```

### 5. Shell Detection on Windows

**Problem:** Spawning processes to detect shells (like `where.exe`) can be slow.

**Bad:**
```rust
fn which_shell(name: &str) -> Option<String> {
    Command::new("where").arg(name).output()  // ❌ Spawns process
}
```

**Good:**
```rust
fn detect_shell() -> String {
    // Check known paths directly
    let paths = [
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Program Files\PowerShell\7\pwsh.exe",
    ];
    for path in &paths {
        if Path::new(path).exists() {
            return path.to_string();
        }
    }
    "cmd.exe".to_string()
}
```

## Debugging Steps

1. **Add console.log statements** at key points to trace execution flow
2. **Check for infinite loops** in `$effect` - add guards and use `$state` for flags
3. **Check array mutations** - always create new arrays for `$state`
4. **Check Rust commands** - add `eprintln!` debug output to trace where it hangs
5. **Use async properly** - ensure blocking operations run off the main thread

## Quick Checklist

- [ ] All `$state` arrays use immutable updates (spread, filter, map)
- [ ] All flags used in `$effect` conditions are `$state` variables
- [ ] Async operations in `$effect` have guards against concurrent execution
- [ ] Rust commands that do I/O are async or use `spawn_blocking`
- [ ] No process spawning for simple checks (use file system checks instead)
