# ONNX Semantic Index Setup (Volt)

## What This Is
Volt now has a hybrid retrieval system:
- lexical search (`rg`) +
- semantic search (local ONNX embeddings).

Semantic search improves fuzzy queries (for example: "timer drift bug"), especially in large repos.

## What Was Implemented
- Real ONNX embedding path in Rust semantic index commands.
- Safe fallback path (`local-onnx-fallback`) if model loading/inference fails.
- Idle-first incremental indexing in the frontend queue.
- Semantic telemetry fields in context/assistant telemetry.

Main files:
- `src-tauri/src/commands/semantic_index.rs`
- `src/lib/services/ai/semantic-index.ts`
- `src/lib/services/ai/semantic-retrieval.ts`
- `src/lib/services/ai/context-v2.ts`

## One-Time Setup (Windows)
Set this once:

```powershell
setx VOLT_SEMANTIC_ONNX_MODEL "C:\tauri\volt\src-tauri\resources\models\all-MiniLM-L6-v2"
```

Then close and reopen terminal.

## Normal Dev Run
After env is set and terminal reopened:

```powershell
npm run tauri dev
```

## Do I Need To Run Env Command Every Time?
No.
- `setx` is persistent for your user.
- You only need to set it again if the path changes.

## How To Verify It Is Working
1. Start app and ask a fuzzy code question.
2. Check telemetry/context stats:
- `semanticBackend: local-onnx` => ONNX active.
- `semanticBackend: local-onnx-fallback` => fallback active (safe, but weaker quality).

## Troubleshooting
### Backend shows fallback
- Confirm env value:

```powershell
echo $env:VOLT_SEMANTIC_ONNX_MODEL
```

- Ensure path exists:

```powershell
Test-Path "C:\tauri\volt\src-tauri\resources\models\all-MiniLM-L6-v2"
```

- Restart app after changing env.

### Remove env override

```powershell
setx VOLT_SEMANTIC_ONNX_MODEL ""
```

## Notes
- The env value should be a **directory path**.
- Lexical retrieval (`rg`) is always available as fallback path.
- ONNX path improves relevance but keeps strict context budget caps.
