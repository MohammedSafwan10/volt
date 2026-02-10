---
id: builtin-background-job-architecture
title: Background Job Architecture
category: Backend
description: Design reliable async job pipeline with retries, idempotency, and observability.
tags: [jobs, queues, backend, reliability]
author: Volt Team
source: builtin
updatedAt: 1739160000000
---
Design background processing for {{workload}}.

Must cover:
- Queue model and worker topology
- Idempotency and deduplication
- Retry/backoff + dead-letter policy
- Failure handling and replay strategy
- Metrics and alerting

