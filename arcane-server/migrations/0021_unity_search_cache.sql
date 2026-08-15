-- Grounding search cache (spec §6): /v1/unity/api/search responses keyed by
-- the normalized request. The corpus is a static ingest, so a 7-day TTL is
-- safe; a cache hit skips the bge embed + Vectorize query entirely
-- (AI-SPEC.md's long-standing "same normalized query re-embeds today" skip).
CREATE TABLE unity_search_cache (
    cache_key TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_unity_search_cache_expiry ON unity_search_cache(expires_at);
