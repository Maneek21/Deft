# ADR: PostgreSQL Job Queue for Launch

- Status: Accepted
- Date: 2026-08-17

## Decision

Deft will keep and harden its custom PostgreSQL `job_queue` for launch. Redis,
BullMQ, their health checks, and their deployment requirements are removed.
Socket.io remains single-instance and in-process for this release.

Community modules in the first release are declarative and cannot register
arbitrary server workers. Core and module-owned background work must use the
same PostgreSQL queue and remain idempotent under at-least-once delivery.

## Why

The application already schedules, claims, retries, and recovers jobs through
PostgreSQL. Neither BullMQ nor Redis is used by the runtime. Keeping unused
infrastructure increases install cost and creates a false architecture contract.
The PostgreSQL queue also keeps application state and job state in one operator-
managed system for the self-hosted launch scope.

## Launch hardening

Before expanding the queue surface, add durable idempotency/deduplication,
race-safe recurring-job registration, renewable claim leases, timeout-safe
execution, retention, graceful shutdown, and queue health metrics.

## When to revisit BullMQ's PostgreSQL backend

Run a separate migration spike only when at least one of these is true:

- third-party modules need scheduled or background execution;
- p95 ready-job lag stays above 2 seconds for 15 minutes;
- ready backlog stays above 1,000 jobs for 5 minutes;
- throughput exceeds 50 jobs/second or queue polling creates measurable database pressure;
- multi-worker coordination, job flows, or rate limits become product requirements; or
- BullMQ's PostgreSQL backend has accumulated another 60–90 days of production maturity.

A dependency-only upgrade is not an adoption path. Any future switch requires
schema ownership, transactional enqueue semantics, migration and rollback plans,
pending-job handling, observability, and crash-recovery certification.
