-- Phase-2/3 harness counters (client-reported, `metadata.telemetry`), now
-- measurable server-side alongside the Phase-1 columns from 0010. Additive
-- only — every column is nullable, matching that migration's convention.
ALTER TABLE request_logs ADD COLUMN grounding_lint_hits INTEGER;
ALTER TABLE request_logs ADD COLUMN loop_guard_hits INTEGER;
ALTER TABLE request_logs ADD COLUMN escalated INTEGER;
ALTER TABLE request_logs ADD COLUMN grounding_tool_calls INTEGER;
ALTER TABLE request_logs ADD COLUMN grounding_unavailable INTEGER;
ALTER TABLE request_logs ADD COLUMN last_turn_latency_ms INTEGER;
