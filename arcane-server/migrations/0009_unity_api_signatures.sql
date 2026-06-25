-- Unity API signature index — the deterministic, exact-lookup half of the
-- version-accurate API grounding (the fuzzy/semantic half lives in Vectorize).
-- Populated by scripts/ingest-unity-docs.ts from a reflection pass over the
-- Unity managed DLLs. Powers the compile-gate's CS1061/CS0117/CS1501 repair and
-- the editor's unity_api_lookup, with no model cost.

CREATE TABLE IF NOT EXISTS unity_api_signatures (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    unity_version    TEXT    NOT NULL,            -- major.minor, e.g. '6000.0'
    namespace        TEXT    NOT NULL DEFAULT '', -- e.g. 'UnityEngine'
    type             TEXT    NOT NULL,            -- declaring type simple name, e.g. 'Rigidbody'
    member           TEXT    NOT NULL,            -- member name, or type name for type rows
    kind             TEXT    NOT NULL,            -- method|property|field|event|ctor|type|enum
    signature        TEXT    NOT NULL,            -- primary signature string
    overloads_json   TEXT,                        -- JSON array of all overload signatures
    assembly         TEXT,                        -- owning assembly, e.g. 'UnityEngine.PhysicsModule'
    deprecated       INTEGER NOT NULL DEFAULT 0,  -- 1 if [Obsolete]
    obsolete_message TEXT,                        -- the [Obsolete] message / replacement hint
    doc_url          TEXT,                        -- version-pinned ScriptReference URL
    UNIQUE(unity_version, type, member, kind)
);

-- Exact lookup of a member's signature(s): (version, type, member).
CREATE INDEX IF NOT EXISTS idx_unity_api_lookup
    ON unity_api_signatures (unity_version, type, member);

-- Enumerate all members of a type (e.g. "what can I call on Rigidbody?").
CREATE INDEX IF NOT EXISTS idx_unity_api_type
    ON unity_api_signatures (unity_version, type);

-- Enumerate deprecated APIs for a version (powers migrations / version upgrades).
CREATE INDEX IF NOT EXISTS idx_unity_api_deprecated
    ON unity_api_signatures (unity_version, deprecated);
