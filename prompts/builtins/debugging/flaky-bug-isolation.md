---
id: builtin-flaky-bug-isolation
title: Flaky Bug Isolation
category: Debugging
description: Isolate nondeterministic failures and stabilize with deterministic checks.
tags: [flaky, race-condition, debugging, reliability]
author: Volt Team
source: builtin
updatedAt: 1739160000000
---
Investigate flaky behavior: {{flaky_issue}}.

Do:
1. Build a deterministic repro harness.
2. Identify timing, shared-state, or async ordering hazards.
3. Add instrumentation logs/guards.
4. Implement stabilization fix.
5. Add regression test to lock behavior.

