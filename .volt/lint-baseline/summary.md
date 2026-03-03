# ESLint Baseline

Generated: 2026-02-27T10:31:17.8109897+05:30

## Totals
- Issues: 399
- Errors: 297
- Warnings: 102
- Files with issues: 108

## Top Rules
- @typescript-eslint/no-explicit-any: 118
- @typescript-eslint/no-unused-vars: 101
- no-useless-escape: 50
- (none): 25
- svelte/require-each-key: 18
- svelte/prefer-svelte-reactivity: 15
- no-empty: 14
- no-useless-assignment: 14
- no-control-regex: 8
- no-undef: 8
- prefer-const: 7
- svelte/no-unused-svelte-ignore: 6
- no-case-declarations: 5
- @typescript-eslint/no-unused-expressions: 4
- svelte/no-at-html-tags: 3
- @typescript-eslint/ban-ts-comment: 1
- preserve-caught-error: 1
- no-import-assign: 1

## Top Files
- src\lib\core\lsp\svelte.ts: 33
- src\lib\core\ai\tools\handlers\index.ts: 21
- src\lib\features\assistant\components\AssistantPanel.svelte: 20
- src\lib\core\ai\tools\handlers\write.ts: 19
- src\lib\features\assistant\components\FileEditCard.svelte: 18
- src\lib\core\ai\providers\gemini.ts: 17
- src\lib\core\ai\tools\handlers\lsp.ts: 15
- src\lib\core\ai\providers\openai.ts: 14
- src\lib\features\assistant\components\InlineToolCall.svelte: 14
- src\lib\core\ai\providers\anthropic.ts: 13
- src\lib\features\terminal\services\terminal-client.ts: 11
- src\lib\features\assistant\components\ChatInputBar.svelte: 10
- src\lib\core\services\monaco-dart-language.ts: 9
- src\lib\core\ai\tools\handlers\read.ts: 7
- src\lib\features\assistant\components\AssistantMessageRow.svelte: 7
- src\lib\core\ai\providers\openrouter.ts: 7
- src\lib\shared\components\layout\MainLayout.svelte: 7
- src\lib\core\ai\tools\utils.ts: 5
- src\lib\core\lsp\dart-sidecar.ts: 5
- src\lib\core\lsp\typescript-sidecar.ts: 5

## Reproduce
- `npx eslint src -f json -o .volt/lint-baseline/eslint-baseline.json`
- `npx eslint src`
