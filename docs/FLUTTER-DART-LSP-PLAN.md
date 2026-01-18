# Flutter & Dart LSP Support Plan for Volt IDE

> **Goal**: Add complete Flutter/Dart development support to Volt, making it the **fastest Flutter IDE** by leveraging Rust + Tauri architecture.

## 📊 Research Summary

### How VS Code Does It (Dart-Code Extension)

The official **Dart-Code** extension (https://github.com/Dart-Code/Dart-Code) provides Flutter/Dart support in VS Code:

1. **Dart Analysis Server** - The core LSP server from Dart SDK (`dart language-server`)
2. **Full LSP Protocol** - Standard LSP + Dart-specific extensions
3. **Flutter Daemon** - For device management, hot reload, hot restart
4. **Debug Adapter Protocol (DAP)** - For debugging Flutter/Dart apps

### Dart Analysis Server Capabilities

From the official LSP spec (https://github.com/dart-lang/sdk/blob/main/pkg/analysis_server/tool/lsp_spec/README.md):

| LSP Method | Status | Notes |
|------------|--------|-------|
| `textDocument/definition` | ✅ | Go to definition |
| `textDocument/references` | ✅ | Find all references |
| `textDocument/hover` | ✅ | Type info + docs |
| `textDocument/completion` | ✅ | Code completion |
| `textDocument/rename` | ✅ | With file rename support |
| `textDocument/codeAction` | ✅ | Quick fixes, refactors, assists |
| `textDocument/formatting` | ✅ | Dart formatter |
| `textDocument/publishDiagnostics` | ✅ | Errors/warnings |
| `textDocument/documentSymbol` | ✅ | File outline |
| `workspace/symbol` | ✅ | Workspace symbol search |
| `textDocument/signatureHelp` | ✅ | Function signatures |
| `textDocument/foldingRange` | ✅ | Code folding |
| `textDocument/semanticTokens` | ✅ | Syntax highlighting |
| `textDocument/inlayHint` | ✅ | Type hints |
| `callHierarchy/*` | ✅ | Call hierarchy |
| `typeHierarchy/*` | ✅ | Type hierarchy |

### Flutter-Specific Features

| Feature | Method |
|---------|--------|
| Closing Labels | `dart/textDocument/publishClosingLabels` |
| Widget Outline | `dart/textDocument/publishFlutterOutline` |
| Hot Reload | Flutter daemon command |
| Hot Restart | Flutter daemon command |
| Device List | Flutter daemon command |
| Widget Inspector | DevTools integration |

---

## 🏗️ Architecture Plan

### Phase 1: Core Dart LSP (Week 1-2)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Volt IDE (Tauri)                        │
├─────────────────────────────────────────────────────────────────┤
│  Frontend (SvelteKit)                                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Monaco Editor  │  │  Dart Sidecar   │  │   AI Tools      │ │
│  │  + Dart Grammar │  │  (TS wrapper)   │  │  (LSP handlers) │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │           │
├───────────┼────────────────────┼────────────────────┼───────────┤
│  Rust Backend                  │                    │           │
│           │           ┌────────▼────────┐           │           │
│           │           │   LspRegistry   │◄──────────┘           │
│           │           │  (dart server)  │                       │
│           │           └────────┬────────┘                       │
│           │                    │                                │
└───────────┼────────────────────┼────────────────────────────────┘
            │                    │
            ▼                    ▼
     ┌──────────────┐    ┌──────────────────────┐
     │ Monaco Types │    │ dart language-server │
     │  (TextMate)  │    │   (from Dart SDK)    │
     └──────────────┘    └──────────────────────┘
```

### Phase 2: Flutter Integration (Week 3-4)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Flutter Development                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Flutter     │  │ Device      │  │ Hot Reload / Restart    │ │
│  │ Projects    │  │ Selector    │  │ (Cmd+S triggers reload) │ │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘ │
│         │                │                      │               │
│         ▼                ▼                      ▼               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Flutter Daemon                          │  │
│  │  flutter daemon  (JSON protocol over stdin/stdout)        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📁 Files to Create

### 1. Dart LSP Sidecar (`src/lib/services/lsp/dart-sidecar.ts`)

```typescript
/**
 * Dart LSP Sidecar Service
 * 
 * Connects to the Dart Analysis Server (dart language-server)
 * for full Dart/Flutter language intelligence.
 */

// Key functions to implement:
// - ensureDartLspStarted() - Start dart language-server
// - getDartDefinition() - textDocument/definition
// - getDartReferences() - textDocument/references
// - getDartHover() - textDocument/hover
// - getDartCompletion() - textDocument/completion
// - getDartCodeActions() - textDocument/codeAction
// - getDartFormatting() - textDocument/formatting
// - notifyDartDocumentOpened/Changed/Closed
// - getDartDiagnostics() - From publishDiagnostics
```

### 2. Dart Monaco Integration (`src/lib/services/lsp/dart-monaco-providers.ts`)

```typescript
/**
 * Monaco providers for Dart
 * 
 * - CompletionItemProvider
 * - HoverProvider  
 * - DefinitionProvider
 * - ReferenceProvider
 * - CodeActionProvider
 * - DocumentFormattingProvider
 */
```

### 3. Flutter Daemon Service (`src/lib/services/flutter/flutter-daemon.ts`)

```typescript
/**
 * Flutter Daemon Service
 * 
 * Manages:
 * - Device enumeration
 * - App launching
 * - Hot reload / hot restart
 * - App stop
 */
```

### 4. AI Tool Handlers (`src/lib/services/ai/tools/handlers/dart.ts`)

```typescript
// Extend lsp.ts with Dart-specific handlers:
// - handleDartDefinition
// - handleDartReferences
// - handleDartHover
// - handleDartCodeActions
// - handleDartFormat
// - handleFlutterHotReload
// - handleFlutterDevices
```

### 5. Dart Problems Store Integration

Already exists - just need to feed Dart diagnostics into `problemsStore`.

---

## 🔧 Implementation Steps

### Step 1: SDK Detection

```typescript
// Detect Dart/Flutter SDK paths
async function detectDartSdk(): Promise<string | null> {
  // 1. Check PATH for 'dart' command
  // 2. Check FLUTTER_ROOT/bin/cache/dart-sdk
  // 3. Check common install locations
  //    - Windows: C:\src\flutter, C:\flutter
  //    - macOS: ~/flutter, /usr/local/flutter
  //    - Linux: ~/flutter, /opt/flutter
}

async function detectFlutterSdk(): Promise<string | null> {
  // 1. Check PATH for 'flutter' command
  // 2. Check FLUTTER_ROOT env variable
  // 3. Check common install locations
}
```

### Step 2: Start Dart Language Server

```bash
# Command to start LSP server
dart language-server --client-id volt-ide --client-version 1.0.0
```

Initialize with capabilities:
```typescript
const initParams = {
  processId: null,
  rootUri: projectRoot,
  capabilities: {
    textDocument: {
      synchronization: { willSave: true, didSave: true },
      completion: { completionItem: { snippetSupport: true } },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      definition: { linkSupport: true },
      references: {},
      codeAction: { codeActionLiteralSupport: { ... } },
      formatting: {},
      publishDiagnostics: { relatedInformation: true },
      // ... more
    },
    workspace: {
      applyEdit: true,
      workspaceFolders: true,
      configuration: true,
    }
  },
  initializationOptions: {
    closingLabels: true,  // Flutter closing labels
    outline: true,
    flutterOutline: true,
  }
};
```

### Step 3: Monaco Language Registration

```typescript
// Register Dart language
monaco.languages.register({ id: 'dart', extensions: ['.dart'] });

// Register TextMate grammar (or use simple tokenizer)
// https://github.com/AUR-Dev/dart-code-textmate-grammar
```

### Step 4: Wire to AI Tools

Update `lsp.ts`:
```typescript
// Add to file type detection
function detectLanguage(path: string): LspType {
  if (path.endsWith('.dart')) return 'dart';
  // ... existing types
}

// Add Dart handlers
if (lspType === 'dart') {
  result = await getDartDefinition(absolutePath, line, column);
}
```

### Step 5: Flutter Daemon Integration

```typescript
// Start Flutter daemon
const daemon = spawn('flutter', ['daemon']);

// Send commands via JSON
daemon.stdin.write(JSON.stringify([{
  method: 'device.getDevices',
  id: 1
}]) + '\n');

// Receive responses
daemon.stdout.on('data', (data) => {
  const messages = parseFlutterDaemonOutput(data);
  // Handle device list, app events, etc.
});
```

---

## 🎯 Feature Priority

### Must Have (Phase 1)
1. ✅ Dart syntax highlighting
2. ✅ Go to definition
3. ✅ Find references
4. ✅ Hover (type info)
5. ✅ Code completion
6. ✅ Diagnostics (errors/warnings)
7. ✅ Code formatting
8. ✅ Code actions (quick fixes)
9. ✅ AI tool integration

### Should Have (Phase 2)
1. 🔄 Flutter project detection
2. 🔄 Device selector
3. 🔄 Hot reload on save
4. 🔄 Flutter run/stop commands
5. 🔄 Widget closing labels
6. 🔄 Flutter outline panel

### Nice to Have (Phase 3)
1. 📋 Widget Inspector integration
2. 📋 DevTools integration
3. 📋 Pub package management
4. 📋 Flutter create project wizard
5. 📋 Widget snippets
6. 📋 Flutter icon previews

---

## ⚡ Why Volt Will Be Faster Than VS Code

| Aspect | VS Code | Volt |
|--------|---------|------|
| Editor Core | Electron (JS) | Tauri (Rust) |
| Memory Usage | ~500MB+ | ~100-200MB |
| Startup Time | 2-5 seconds | <1 second |
| File Operations | Node.js fs | Rust tokio async |
| IPC | Electron IPC | Tauri commands (faster) |
| LSP Transport | Node spawn | Rust spawn_blocking |

The Dart Analysis Server itself is the same, but Volt's lower overhead means:
- Faster file tree navigation
- Quicker file open/save
- Less memory competition with LSP
- Snappier UI responses

---

## 📦 No Bundled Binaries Needed

Unlike TypeScript LSP which we bundle, for Dart/Flutter:

**User Must Install:**
1. Flutter SDK (includes Dart SDK)
2. That's it!

**Why?**
- Flutter SDK is 2GB+ (too big to bundle)
- Users need `flutter` CLI for running apps anyway
- Cross-platform installation is already easy

**Volt's Job:**
- Detect installed SDK
- Launch `dart language-server` from SDK
- Launch `flutter daemon` from SDK
- Provide UI for Flutter features

---

## 🔄 Comparison: TypeScript LSP vs Dart LSP

| Aspect | TypeScript | Dart |
|--------|------------|------|
| Server | Bundled (`tsserver`) | User's SDK (`dart language-server`) |
| Start Command | `node typescript-language-server --stdio` | `dart language-server --client-id volt` |
| Protocol | Standard LSP | Standard LSP + Dart extensions |
| Extra Daemon | None | Flutter daemon (for hot reload) |
| File Extensions | .ts, .tsx, .js, .jsx | .dart |
| Sidecar Pattern | Same | Same |

---

## 📝 Files to Modify

1. **`src/lib/services/lsp/sidecar/register.ts`**
   - Add 'dart' to LspServerType
   - Add Dart server configuration

2. **`src/lib/stores/project.svelte.ts`**
   - Detect pubspec.yaml → Flutter project
   - Store dartSdkPath, flutterSdkPath

3. **`src/lib/services/ai/tools/handlers/lsp.ts`**
   - Add 'dart' to language detection
   - Route to Dart sidecar functions

4. **`src/lib/services/ai/tools/definitions.ts`**
   - Update LSP tool descriptions to include Dart

5. **`src/lib/components/editor/CodeEditor.svelte`**
   - Register Dart Monaco providers

---

## 🚀 Getting Started

### Prerequisites Check
```typescript
async function checkFlutterPrerequisites(): Promise<{
  dartSdk: string | null;
  flutterSdk: string | null;
  flutterVersion: string | null;
  dartVersion: string | null;
}> {
  // Run: flutter --version, dart --version
  // Parse output for versions and paths
}
```

### User Experience Flow
1. User opens a folder with `pubspec.yaml`
2. Volt detects Flutter project
3. Status bar shows "Flutter" + version
4. Dart LSP starts automatically
5. All LSP features work
6. Device selector appears (if Flutter SDK found)
7. User can run/debug Flutter apps

---

## 📈 Estimated Timeline

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| Phase 1 | 2 weeks | Core Dart LSP (definition, references, hover, completion, diagnostics) |
| Phase 2 | 2 weeks | Flutter integration (devices, hot reload, run/stop) |
| Phase 3 | 2 weeks | Polish (widget inspector, DevTools, pub commands) |

**Total: 6 weeks for full Flutter support**

---

## 📚 References

- Dart Analysis Server LSP: https://github.com/dart-lang/sdk/blob/main/pkg/analysis_server/tool/lsp_spec/README.md
- Dart-Code Extension: https://github.com/Dart-Code/Dart-Code
- Flutter Daemon Protocol: https://github.com/flutter/flutter/wiki/The-flutter-daemon-mode
- Dart TextMate Grammar: https://github.com/AUR-Dev/dart-code-textmate-grammar
- LSP Specification: https://microsoft.github.io/language-server-protocol/

---

## ✅ Summary

**Volt can absolutely support Flutter/Dart** with the same sidecar pattern used for TypeScript. The key differences:

1. **No bundled binaries** - Use user's Flutter SDK
2. **Extra daemon** - Flutter daemon for hot reload
3. **Rich extensions** - Dart LSP has Flutter-specific features

This will make Volt a **serious contender for Flutter development** - faster than VS Code with full LSP intelligence!
