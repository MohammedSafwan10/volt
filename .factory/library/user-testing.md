# User Testing

Testing surface, required testing skills/tools, and validation concurrency guidance.

**What belongs here:** user-visible validation surfaces, dry-run findings, accepted limitations, concurrency guidance.

---

## Validation Surface

User-testing is currently waived as a mission gate by explicit user instruction. Treat this file as reference-only for optional future user-surface checks, not as a blocker for continuing implementation.

The user has also explicitly asked to avoid repeated validation during feature work. During implementation, keep checks minimal and move quickly; defer the main verification pass to the mission end, where `cargo check --manifest-path src-tauri/Cargo.toml` is the required final gate.

### Primary recurring surfaces

1. **Static/runtime validation commands**
   - `npm run test`
   - `npm run check`
   - `npm run lint` (advisory until stabilized)
   - `cargo check --manifest-path src-tauri/Cargo.toml`
   - `cargo test --manifest-path src-tauri/Cargo.toml`

2. **Local app surface**
   - Existing frontend/Tauri dev URL: `http://localhost:1420`
   - This URL is an internal Tauri desktop-dev helper, not a supported browser validation target
   - Do not treat browser validation against this URL as the primary product-surface check for this mission

3. **Integrated desktop validation**
   - Prefer milestone-point desktop checks such as `npm run tauri build` when practical
   - Treat this as heavier and less frequent than unit/check validation
   - Do not launch `npm run tauri dev` by default; the user will perform manual desktop-shell checks for now unless they explicitly re-enable worker-run Tauri validation

### Accepted limitations from planning

- Validation baseline is currently imperfect; stabilization work is in scope
- `cargo check` was blocked during dry run by a Windows/Tauri permission problem
- The internal `http://localhost:1420` dev helper was not confirmed stable during dry run
- Browser/CDP validation is intentionally out of scope because the mission removes that functionality
- Volt should be validated as a desktop-first IDE, not as a web-published app
- User-owned manual desktop-shell verification is an accepted limitation for now; workers/validators should report what needs checking instead of launching `npm run tauri dev` by default
- User-testing/manual desktop validation is not required for mission progression unless the user later opts back in

## Validation Concurrency

### Surface: static validators
- Max concurrent validators: **1**
- Resource cost: **moderate**
- Reasoning:
  - planning dry run showed the machine already moderately loaded
  - these checks are meaningful but should run sequentially to reduce noisy failures and contention

### Surface: local app / desktop validation
- Max concurrent validators: **1**
- Resource cost: **heavy**
- Reasoning:
  - local memory headroom was limited during planning
  - existing processes already included Volt, Droid, rust-analyzer, WebView, and language servers
  - desktop/native validation should remain conservative and sequential

## Dry-run summary

- `npm run check`, `npm run lint`, and `npm run test` executed but were already red
- `cargo check --manifest-path src-tauri/Cargo.toml` hit a Windows/Tauri permission blocker
- `npm run dev:with-sidecars` did not yield a confirmed stable `http://localhost:1420` surface during the dry run

Workers and validators should not assume the validation path is healthy until they verify it for their milestone.
