-- Phase 11 — gateway connectivity ping
-- Adds per-gateway ping tracking columns distinct from the existing
-- proactive heartbeat (last_heartbeat_at) used by agent-employee-heartbeat.ts.
ALTER TABLE agent_employees
  ADD COLUMN IF NOT EXISTS last_gateway_ping_at timestamp,
  ADD COLUMN IF NOT EXISTS gateway_ping_fail_count integer NOT NULL DEFAULT 0;
