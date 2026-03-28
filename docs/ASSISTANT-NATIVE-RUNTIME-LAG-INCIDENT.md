# Assistant Native Runtime Lag Incident

## Summary

We hit a severe whole-IDE lag regression after:

- moving more assistant runtime behavior to Rust/native
- splitting `AssistantPanel.svelte` into smaller modules

The app felt globally delayed:

- typing in the assistant input lagged
- sending the second message felt sticky
- buttons across the IDE felt delayed
- the issue looked like a Rust/native performance problem at first

The actual root cause was mostly **frontend bridge/reactivity churn**, not slow Rust execution.

## User-Visible Symptoms

- first message could feel okay, then later interactions became laggy
- assistant persistence logs repeated for the same conversation/message ids
- UI felt delayed even when Rust command timings were very small
- whole app responsiveness degraded, not just chat streaming

## What Was Actually Wrong

### 1. Duplicate persistence paths

We had two persistence flows active at once:

- per-message persistence from `assistant.svelte.ts`
- whole-conversation persistence after `runToolLoop(...)` in `AssistantPanel.svelte`

That caused repeated:

- `createConversation(...)`
- `saveMessage(...)`

for the same ids.

Files involved:

- `src/lib/features/assistant/stores/assistant.svelte.ts`
- `src/lib/features/assistant/components/AssistantPanel.svelte`
- `src/lib/features/assistant/stores/chat-history.svelte.ts`

### 2. Native snapshot hydration loop

After the native-runtime move, the panel had a hot `$effect(...)` that called:

- `hydrateNativeAssistantSnapshot(conversationId)`

too often for the same conversation.

That created a feedback loop:

1. native/runtime event updates store
2. store update reruns panel effect
3. effect re-hydrates native snapshot again
4. snapshot reapplies store state
5. repeat

Files involved:

- `src/lib/features/assistant/components/AssistantPanel.svelte`
- `src/lib/features/assistant/components/panel/native-runtime-bridge.ts`

## Why It Felt So Bad

This regression was deceptive because:

- Rust calls were individually fast
- no single backend command looked “slow”
- the problem was repeated work, not expensive work

So even tiny `0-5ms` native calls became harmful when triggered repeatedly by reactive loops.

That kind of bug makes the whole app feel heavy because it increases:

- store writes
- component invalidation
- DOM work
- bridge traffic between frontend and native
- follow-on effects like chat scroll updates and message recalculation

## Fixes Applied

### Fix 1: Remove duplicate whole-conversation save

Removed the extra auto-save-after-send path from:

- `src/lib/features/assistant/components/AssistantPanel.svelte`

We now rely on the existing per-message persistence path instead of saving the whole conversation again after each run.

### Fix 2: Make conversation creation locally idempotent

Updated:

- `src/lib/features/assistant/stores/chat-history.svelte.ts`

So `createConversation(id, mode)` returns the already-known local summary when the conversation already exists, instead of re-invoking Rust unnecessarily.

### Fix 3: Guard native snapshot hydration

Updated:

- `src/lib/features/assistant/components/AssistantPanel.svelte`

So native snapshot hydration only runs when the actual conversation id changes, not on ordinary message/runtime churn inside the same conversation.

## How We Confirmed It

Rust-side debug tracing showed:

- backend commands were fast
- but the same chat persistence operations were firing repeatedly for the same ids

That was the key clue that the main issue was repeated frontend-triggered work, not a slow native subsystem.

Relevant traced areas:

- chat store
- native runtime bridge
- file index
- semantic commands
- LSP lifecycle
- watch commands

## Prevention Checklist

When changing assistant runtime, panel wiring, or persistence logic:

- Never persist the same conversation through both:
  - per-message persistence
  - end-of-run whole-conversation persistence

- Guard native snapshot hydration by identity:
  - only hydrate when conversation/run identity actually changes

- Treat `$effect(...)` blocks around runtime sync as high-risk:
  - avoid re-running native calls from effects that can fire on normal message churn

- Prefer idempotent frontend bridge methods:
  - especially `createConversation(...)`
  - snapshot sync
  - event subscription setup

- When the app feels globally laggy, check for:
  - repeated fast calls
  - repeated store updates
  - duplicated subscriptions/effects
  - bridge loops

## Rule Of Thumb

If native timings are small but the whole UI still feels slow, suspect:

- duplicated reactive work
- repeated bridge invocations
- store synchronization loops

before assuming Rust itself is the bottleneck.
