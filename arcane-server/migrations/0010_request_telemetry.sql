-- Per-request agent telemetry (client-reported) + provider cache hits.
ALTER TABLE request_logs ADD COLUMN task_type TEXT;
ALTER TABLE request_logs ADD COLUMN turn_index INTEGER;
ALTER TABLE request_logs ADD COLUMN tool_error_count INTEGER;
ALTER TABLE request_logs ADD COLUMN repair_count INTEGER;
ALTER TABLE request_logs ADD COLUMN cached_input_tokens INTEGER;
