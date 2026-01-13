# Volt Browser Panel - Implementation Plan

## Overview

Embedded browser in Volt IDE with AI-powered element inspection and UI/UX suggestions.

## Goals

1. Full browser view that replaces editor area when active
2. Navigate any URL (localhost, external sites, Google search)
3. Element selector mode (like DevTools inspect)
4. Select element → Share to AI for suggestions
5. AI can control browser for automated testing/debugging

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Webview | wry/WebView2 (Rust) | Native, fast, full Chrome engine |
| Browser UI | Svelte | Consistent with app |
| Element selector | Injected JS | Required for DOM access |
| AI integration | TypeScript | Existing AI service |
| Screenshots | Rust (wry) | Fast, native |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Svelte Frontend                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ BrowserPanel.svelte                                     │ │
│ │ - URL bar, navigation buttons                           │ │
│ │ - Select mode toggle                                    │ │
│ │ - Selected element display                              │ │
│ └─────────────────────────────────────────────────────────┘ │
│                           │                                 │
│                           ▼                                 │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ browser.svelte.ts (Store)                               │ │
│ │ - URL state, history                                    │ │
│ │ - Selected element data                                 │ │
│ │ - Browser mode (normal/select)                          │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ Tauri Commands
┌─────────────────────────────────────────────────────────────┐
│ Rust Backend (src-tauri/src/commands/browser.rs)           │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Commands:                                               │ │
│ │ - create_browser_view(url) → webview_id                 │ │
│ │ - navigate(webview_id, url)                             │ │
│ │ - go_back(webview_id)                                   │ │
│ │ - go_forward(webview_id)                                │ │
│ │ - reload(webview_id)                                    │ │
│ │ - inject_selector_script(webview_id)                    │ │
│ │ - take_screenshot(webview_id) → base64                  │ │
│ │ - execute_js(webview_id, script) → result               │ │
│ │ - close_browser_view(webview_id)                        │ │
│ └─────────────────────────────────────────────────────────┘ │
│                           │                                 │
│                           ▼                                 │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ wry WebView (Native)                                    │ │
│ │ - WebView2 on Windows (Chrome engine)                   │ │
│ │ - WebKit on macOS/Linux                                 │ │
│ │ - Full browser capabilities                             │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Phases

### Phase 1: Basic Browser Panel (MVP)
**Goal**: Show a working browser in the editor area

**Files to create:**
- `src/lib/components/browser/BrowserPanel.svelte` - Main UI
- `src/lib/components/browser/BrowserToolbar.svelte` - URL bar, buttons
- `src/lib/stores/browser.svelte.ts` - State management
- `src-tauri/src/commands/browser.rs` - Rust commands

**Features:**
- [ ] Browser icon in sidebar
- [ ] Click → shows browser panel (hides editor)
- [ ] URL bar with input
- [ ] Navigate to any URL
- [ ] Back, Forward, Refresh buttons
- [ ] Loading indicator
- [ ] Close browser → return to editor

**Rust Commands:**
```rust
#[tauri::command]
async fn create_browser_webview(app: AppHandle, url: String) -> Result<String, String>

#[tauri::command]
async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String>

#[tauri::command]
async fn browser_back(app: AppHandle) -> Result<(), String>

#[tauri::command]
async fn browser_forward(app: AppHandle) -> Result<(), String>

#[tauri::command]
async fn browser_reload(app: AppHandle) -> Result<(), String>

#[tauri::command]
async fn close_browser_webview(app: AppHandle) -> Result<(), String>
```

### Phase 2: Element Selector
**Goal**: Inspect and select elements like DevTools

**Features:**
- [ ] "Select Element" button/mode
- [ ] Hover highlights elements with blue border
- [ ] Click selects element
- [ ] Show selected element info:
  - Tag name, classes, ID
  - Computed CSS (key properties)
  - Bounding box
  - Parent chain
- [ ] Copy selector button

**Injected Script:**
```javascript
// Injected into webview for element selection
(function() {
  let overlay = null;
  let selectedElement = null;
  
  function highlight(el) {
    // Create/move overlay to highlight element
  }
  
  function select(el) {
    // Extract element info and send to Tauri
    window.__TAURI__.invoke('element_selected', {
      tagName: el.tagName,
      id: el.id,
      classes: [...el.classList],
      html: el.outerHTML.slice(0, 500),
      css: getComputedStyles(el),
      rect: el.getBoundingClientRect(),
      selector: generateSelector(el)
    });
  }
  
  document.addEventListener('mousemove', (e) => highlight(e.target));
  document.addEventListener('click', (e) => { e.preventDefault(); select(e.target); });
})();
```

### Phase 3: AI Integration
**Goal**: Send selected elements to AI for suggestions

**Features:**
- [ ] "Ask AI" button on selected element
- [ ] Pre-filled prompt: "Improve this element's UI/UX"
- [ ] AI receives:
  - Element HTML
  - Current CSS
  - Screenshot of element (optional)
  - Context (what page, what component)
- [ ] AI suggests:
  - Better colors, spacing
  - Accessibility improvements
  - Responsive design fixes
  - Modern CSS alternatives

**AI Tools:**
```typescript
// New AI tools for browser
browser_screenshot: () => base64Image
browser_get_element: (selector) => { html, css, rect }
browser_click: (selector) => void
browser_type: (selector, text) => void
browser_navigate: (url) => void
```

### Phase 4: Advanced Features
**Goal**: Full browser automation for AI

**Features:**
- [ ] Console log capture
- [ ] Network request inspection
- [ ] Performance metrics
- [ ] Responsive mode (mobile/tablet presets)
- [ ] Multiple browser tabs
- [ ] DevTools panel (simplified)
- [ ] Record user actions → generate test code

## File Structure

```
src/
├── lib/
│   ├── components/
│   │   └── browser/
│   │       ├── BrowserPanel.svelte      # Main container
│   │       ├── BrowserToolbar.svelte    # URL bar, buttons
│   │       ├── ElementInspector.svelte  # Selected element info
│   │       └── index.ts                 # Exports
│   ├── stores/
│   │   └── browser.svelte.ts            # Browser state
│   └── services/
│       └── browser/
│           ├── selector.ts              # Element selector logic
│           └── ai-tools.ts              # AI browser tools

src-tauri/
├── src/
│   ├── commands/
│   │   └── browser.rs                   # Browser Rust commands
│   └── lib.rs                           # Register commands
```

## UI Mockup

### Normal Mode
```
┌─────────────────────────────────────────────────────────────┐
│ ← → ↻  [https://localhost:5173          ] [🎯] [📷] [✕]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    Web Page Content                         │
│                                                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Select Mode (element hovered)
```
┌─────────────────────────────────────────────────────────────┐
│ ← → ↻  [https://localhost:5173          ] [🎯✓] [📷] [✕]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│     ┌─────────────────────────────┐                         │
│     │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ ← Blue highlight       │
│     │ ░░░ Hovered Element ░░░░░░░ │                         │
│     │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░ │                         │
│     └─────────────────────────────┘                         │
│                                                             │
│  [Click to select element]                                  │
└─────────────────────────────────────────────────────────────┘
```

### Element Selected
```
┌─────────────────────────────────────────────────────────────┐
│ ← → ↻  [https://localhost:5173          ] [🎯✓] [📷] [✕]  │
├─────────────────────────────────────────────────────────────┤
│                         │ SELECTED ELEMENT                  │
│    Web Page Content     │ ─────────────────────────────────│
│                         │ <button class="btn-primary">     │
│    [Selected ✓]         │   Click me                       │
│                         │ </button>                        │
│                         │                                  │
│                         │ CSS:                             │
│                         │ • background: #3b82f6            │
│                         │ • padding: 8px 16px              │
│                         │ • border-radius: 4px             │
│                         │                                  │
│                         │ [Copy Selector] [🤖 Ask AI]      │
└─────────────────────────────────────────────────────────────┘
```

## Dependencies

### Rust (Cargo.toml)
```toml
# Already have wry via tauri
# May need for screenshots:
image = "0.24"
base64 = "0.21"
```

### No new npm dependencies needed

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CORS blocks external sites | Element selector works best on localhost |
| WebView2 not installed | Show install prompt, fallback message |
| Performance with large pages | Throttle highlight updates |
| Security (injected scripts) | Only inject on user action, sandbox |

## Success Metrics

- [ ] Can browse any URL
- [ ] localhost apps work perfectly
- [ ] Element selection is smooth (<16ms highlight)
- [ ] AI receives accurate element data
- [ ] AI suggestions are actionable

## Timeline Estimate

- Phase 1: 2-3 hours (basic browser)
- Phase 2: 3-4 hours (element selector)
- Phase 3: 2-3 hours (AI integration)
- Phase 4: 4-6 hours (advanced features)

Total: ~12-16 hours of development

---

## Next Steps

1. ~~Create browser store (`browser.svelte.ts`)~~ ✅
2. ~~Create Rust browser commands (`browser.rs`)~~ ✅
3. ~~Create BrowserPanel component~~ ✅
4. ~~Add browser icon to sidebar~~ ✅
5. ~~Implement native Tauri webview~~ ✅ (Phase 2)
6. ~~Add element selection via injected scripts~~ ✅ (Phase 2)
7. ~~Test with localhost and external URLs~~ ✅
8. ~~Add screenshot functionality~~ ✅ (Phase 3)
9. ~~Add console log capture~~ ✅ (Phase 4 - Sprint 1)
10. ~~Add AI browser tools~~ ✅ (9 tools registered)
11. Add Network Panel UI (Phase 4 - Sprint 2)
12. Add Performance Panel UI (Phase 4 - Sprint 2)

---

## How to Select Element & Send to AI

### Step 1: Enable Select Mode
Click the **target icon** (🎯) in the browser toolbar to enter element selection mode.

### Step 2: Select an Element
- Hover over elements to see them highlighted with a blue border
- Click on any element to select it
- The **Element Inspector** panel appears on the right

### Step 3: Send to AI
In the Element Inspector, you have 4 AI action buttons:

| Button | What it does |
|--------|--------------|
| **Improve UI/UX** | Asks AI to suggest better colors, spacing, typography |
| **Check Accessibility** | Asks AI to check WCAG compliance issues |
| **Make Responsive** | Asks AI to suggest mobile/tablet/desktop CSS |
| **Modernize CSS** | Asks AI to suggest flexbox, grid, modern properties |

Clicking any button:
1. Opens the AI Assistant panel
2. Pre-fills the input with your selected element's HTML, CSS, and selector
3. You can add your own instructions before sending

### Custom Instructions
You can also:
1. Select an element
2. Copy the selector (CSS or XPath)
3. Open AI chat manually
4. Type your own question like: "How do I animate this button on hover?"

---

## AI Browser Tools (Available to AI)

The AI can now use these tools to help debug:

| Tool | Description |
|------|-------------|
| `browser_get_console_logs` | Get console logs with filtering |
| `browser_get_errors` | Get JS errors with stack traces |
| `browser_get_network_requests` | Get network requests |
| `browser_get_performance` | Get page load metrics |
| `browser_get_selected_element` | Get currently selected element |
| `browser_get_summary` | Quick overview of browser state |
| `browser_navigate` | Navigate to URL |
| `browser_click` | Click element by selector |
| `browser_type` | Type into input field |

---

## Current Implementation Status

### ✅ Completed
- Basic browser with navigation
- URL bar, back/forward/reload
- Bookmarks (add/remove/view)
- History tracking
- Zoom controls
- Responsive mode presets
- Element selection mode
- Element Inspector with AI actions
- Console log capture
- Error capture (JS errors + unhandled rejections)
- Network request capture
- Performance metrics capture
- DevTools panel UI (Console tab)
- AI browser tools (9 tools)

### 🔄 In Progress
- Network Panel UI (data captured, UI placeholder)
- Performance Panel UI (data captured, UI placeholder)

### 📋 Future
- Multiple browser tabs
- Record user actions → generate test code
- Ad blocker (CSS injection)
- Auto-refresh on file save
