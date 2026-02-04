# Prompt Library (Volt) — MVP + Scale Plan

## Summary
Build a fast, smooth Prompt Library that works offline now and scales to hundreds of thousands of prompts later. Start with local built‑in prompts stored in a JSON file plus user custom prompts stored locally. Later add server APIs for trending/community prompts.

## Goals
- Fast, smooth UI (no lag with large libraries).
- Offline by default.
- Simple UX: Copy, Add to Input, Run.
- Safe future scalability to 100k+ prompts.
- High‑value, engineered prompts that deliver consistent results.

## Storage Strategy (Recommended)

### MVP (Now)
1) Built‑in prompts: `static/prompts.json`
2) User prompts: localStorage (or local file later)

### Future (Scale)
- Built‑in: local JSON cached
- User prompts: local storage
- Trending/community: server API with pagination + caching

## Data Model
Each prompt:
- `id` (string)
- `title` (string)
- `category` (string)
- `description` (string)
- `template` (string, supports {{variables}})
- `tags` (string[])
- `author` (string)
- `source` (builtin | user | server)
- `updatedAt` (timestamp)

## MVP Features
- Sidebar Prompt Library panel
- Search bar + category filter
- Prompt cards
- Actions: Copy / Add to Input / Run
- Variable editor (simple modal)
- Save user prompts
- Favorites

## Prompt Quality Guidelines (What We Expect)
- Prompts must be **task‑complete**, not one‑liners.
- Include **intent + constraints + output format** in the prompt.
- Prefer **multi‑step prompts** (analyze → propose → implement).
- Avoid vague prompts (e.g., “make it better”).
- Prompts should be **reusable across projects**.
- If code is required, prompt should ask for **summary + edits** rather than dumping huge code blocks.

## Prompt Types We Will Include
1. UI/UX Upgrade (premium SaaS polish)
2. UX Audit + Fix Plan (top issues + implement top fixes)
3. Performance Optimization (identify bottlenecks + fix top one)
4. Root‑Cause Debugging (find cause, explain, fix)
5. Refactor for Readability (maintain behavior)
6. Accessibility Upgrade (WCAG + keyboard)
7. Feature Spec Generator (PRD + user stories + edge cases)
8. Agent Build Plan (steps + execute step 1)
9. Design System Starter (tokens + apply)
10. Conversion Copy (landing copy + implement)
11. Error/Empty States (user‑friendly)
12. Data Modeling + Schema (tables + seed data)
13. API Blueprint (endpoints + payloads + errors)
14. Security Quick Audit (find + fix critical)
15. Test Plan + Cases (unit/integration/manual)

## Performance Requirements
- Virtualized list rendering (only render visible items)
- Indexed search (precomputed token index)
- Debounced search input
- Lazy load categories
- Limit preview text (truncate)

## UX Behavior
- Clicking a prompt opens a details drawer
- “Add to Input” fills chat input
- “Run” fills + sends
- “Copy” copies raw prompt text

## AI Integration (Later)
- AI can generate a prompt and save to library
- AI can suggest prompt category + tags
- Toggle: allow AI to edit prompt library

## Future Enhancements
- Prompt packs (bundles)
- Trending panel
- Share/export prompt JSON
- Team libraries

## Tests
- Load 10k prompts with no lag
- Search returns results in <200ms
- Variable fill works correctly
- Add to input + run works
- User prompts persist after reload
