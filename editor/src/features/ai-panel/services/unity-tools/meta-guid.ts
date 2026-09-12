/**
 * GUID / `.meta` generation for UI Toolkit assets the agent creates.
 *
 * A `.uxml`/`.uss` the agent just wrote has no GUID until Unity imports it and
 * assigns one — which does not happen inside this process, and does not
 * happen at all while the Editor is mid-recompile or unfocused. Without a
 * GUID, `<Style src="project://database/...guid=...">` cannot be built, and
 * `unity_attach_ui_document` (Task 12) cannot resolve the new document either.
 * So this module lets the writer assign the GUID itself, the same way Unity's
 * own importer would on first import.
 *
 * Three facts about how Unity treats a `.meta` make this safe:
 *
 *   - **Unity adopts a pre-existing `.meta`'s GUID on first import.** If the
 *     `.meta` is already sitting next to the asset the moment the Asset
 *     Database sees it, that GUID becomes the asset's permanent identity —
 *     it does not get silently discarded and replaced.
 *   - **A conflicting GUID is reassigned, with a warning.** If two assets
 *     somehow claim the same GUID, Unity keeps the first and generates a new
 *     one for the second, logging a console warning. `allocateGuid` avoids
 *     this case rather than relying on it (see below), but it is not a
 *     silent-corruption risk if it ever happens anyway.
 *   - **A `.meta` written for an ALREADY-IMPORTED file is ignored.** Unity
 *     keeps the GUID it already assigned; a second `.meta` next to an asset
 *     it already knows about changes nothing. This is why the writer using
 *     this module only ever creates a `.meta` when none exists yet — writing
 *     one over an existing file's `.meta` would be pointless at best.
 *
 * Collision avoidance for a freshly allocated GUID has two sources: the
 * project's persistent GUID index (the `unity_index_guid_map` Tauri command,
 * Rust `unity_index.rs` — every `.meta` Unity has ever written), and a
 * per-send `issued` set the caller threads through, so two `unity_ui_write`
 * calls in the same send (before either GUID has been indexed) cannot hand
 * out the same one.
 *
 * Pure module: no imports, no I/O, directly testable under Bun.
 */

export type MetaKind = 'uxml' | 'uss';

/** 32 lowercase-hex zero GUID — never a legal allocation. */
const ALL_ZERO_GUID = '0'.repeat(32);

/**
 * Unity's own reserved-resource GUID family: 16 zeros, then `e` or `f`, then
 * 15 more zeros — e.g. `0000000000000000e000000000000000` (built-in
 * resources) and the `f000…` sibling (built-in extra resources). These are
 * the guids Unity's own built-in ScriptedImporter types are addressed by
 * (see `buildMetaText`'s default below); a freshly allocated asset GUID must
 * never collide with this family even though a true collision is
 * astronomically unlikely from 128 random bits.
 */
const RESERVED_FAMILY = /^0{16}[ef]0{15}$/;

/** A source of cryptographically random bytes, matching `crypto.getRandomValues`'s shape. */
export type RandomBytes = (out: Uint8Array) => Uint8Array;

function defaultRandom(out: Uint8Array): Uint8Array {
  return crypto.getRandomValues(out);
}

/** 16 random bytes as 32 lowercase hex characters — a Unity-shaped GUID. */
export function newUnityGuid(random: RandomBytes = defaultRandom): string {
  const bytes = random(new Uint8Array(16));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Attempts `allocateGuid` makes before giving up — collisions this deep mean something is wrong upstream. */
const MAX_ATTEMPTS = 5;

export interface AllocateGuidOptions {
  /** True if a guid is already claimed by the project's persistent GUID index. */
  taken: (guid: string) => boolean;
  /** GUIDs already handed out earlier in this send, not yet reflected in `taken`. Mutated: the new guid is added. */
  issued: Set<string>;
  random?: RandomBytes;
}

/**
 * Allocate a GUID no known asset already holds. Retries on collision (the
 * all-zero guid, the reserved family, `taken`, or already `issued` this
 * send), up to {@link MAX_ATTEMPTS} times, then throws — a real collision
 * this deep almost certainly means `taken`/`issued` were passed wrong, and
 * silently returning a colliding guid would corrupt whichever asset loses
 * Unity's reassignment.
 */
export function allocateGuid(options: AllocateGuidOptions): string {
  const random = options.random ?? defaultRandom;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const guid = newUnityGuid(random);
    if (guid === ALL_ZERO_GUID) continue;
    if (RESERVED_FAMILY.test(guid)) continue;
    if (options.issued.has(guid)) continue;
    if (options.taken(guid)) continue;
    options.issued.add(guid);
    return guid;
  }
  throw new Error(`Could not allocate a unique GUID after ${MAX_ATTEMPTS} attempts.`);
}

// ── .meta text ───────────────────────────────────────────────────────────────

/** Importer `script:` fileID Unity's UI Builder writes for each kind. */
const IMPORTER_FILE_ID: Record<MetaKind, number> = { uxml: 13804, uss: 12385 };

/** The reserved built-in-resources guid every ScriptedImporter `script:` reference uses. */
const BUILTIN_IMPORTER_GUID = '0000000000000000e000000000000000';

/** The line `.meta` YAML carries its guid on — always the second line Unity writes. */
const GUID_LINE = /^guid:\s*[0-9a-fA-F]{32}[ \t]*$/m;

/** Replace the `guid:` line in `template`, or `null` if it has none to replace. */
function withReplacedGuid(template: string, guid: string): string | null {
  if (!GUID_LINE.test(template)) return null;
  return template.replace(GUID_LINE, `guid: ${guid}`);
}

/**
 * The bare minimum a `.meta` needs: `fileFormatVersion` and `guid`. Unity
 * fills in an importer-appropriate body on next import — this is the same
 * shape Unity itself writes for a `.meta` created with no importer opinion.
 * Reachable directly as the fallback for a `kind` the importer table above
 * does not recognize.
 */
export function minimalMetaText(guid: string): string {
  return `fileFormatVersion: 2\nguid: ${guid}\n`;
}

/**
 * The shape Unity's own UI Builder writes for a new `.uxml`/`.uss`: a
 * `ScriptedImporter` whose `script:` names the built-in UXML/USS importer
 * type by its reserved guid (see {@link BUILTIN_IMPORTER_GUID}) and fileID
 * (see {@link IMPORTER_FILE_ID}).
 */
function uiBuilderDefault(kind: MetaKind, guid: string): string {
  const fileId = IMPORTER_FILE_ID[kind];
  if (fileId === undefined) return minimalMetaText(guid);
  return [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'ScriptedImporter:',
    '  internalIDToNameTable: []',
    '  externalObjects: {}',
    '  serializedVersion: 2',
    `  script: {fileID: ${fileId}, guid: ${BUILTIN_IMPORTER_GUID}, type: 0}`,
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    '',
  ].join('\n');
}

/**
 * Build a `.meta` file's text for a freshly written `.uxml`/`.uss`.
 *
 * Three rungs, in order:
 *   1. `template` given and it has a `guid:` line to replace — reuse it
 *      verbatim otherwise, so an existing project's importer settings
 *      (label, name overrides, anything UI Builder or a later Unity version
 *      added) survive onto the new asset instead of being reset to defaults.
 *   2. No usable template — the UI-Builder-shaped default for `kind`.
 *   3. An unrecognized `kind` — the minimal form (see {@link minimalMetaText};
 *      unreachable through the exported `MetaKind` type, kept as the same
 *      belt-and-suspenders fallback the rest of this codebase's write gates
 *      use rather than ever throwing out of a writer).
 */
export function buildMetaText(kind: MetaKind, guid: string, template?: string): string {
  if (template) {
    const replaced = withReplacedGuid(template, guid);
    if (replaced !== null) return replaced;
  }
  return uiBuilderDefault(kind, guid);
}

/** The GUID a `.meta`'s text declares, or `null` if it has none (unreadable/corrupt). */
export function extractGuidFromMeta(metaText: string): string | null {
  const m = /^guid:\s*([0-9a-fA-F]{32})[ \t]*$/m.exec(metaText);
  return m ? m[1].toLowerCase() : null;
}

// ── `<Style src>` ────────────────────────────────────────────────────────────

/** Escape the characters that are structurally significant inside an XML attribute value. */
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function basenameNoExt(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The `<Style src="...">` value UI Builder writes: a `project://database/`
 * URI keyed by the stylesheet's own GUID, so it resolves to the exact asset
 * regardless of any later rename or move. `&amp;` is the LITERAL separator
 * UXML (an XML format) requires between query parameters inside an attribute
 * value — this is not double-escaping, `escapeXmlAttr` only ever touches
 * `ussProjectPath`.
 */
export function styleSrcFor(ussProjectPath: string, guid: string): string {
  const path = escapeXmlAttr(ussProjectPath);
  const basename = escapeXmlAttr(basenameNoExt(ussProjectPath));
  return `project://database/${path}?fileID=7433441132597879392&amp;guid=${guid}&amp;type=3#${basename}`;
}

/**
 * Fallback `<Style src="...">` when no GUID is available (an existing
 * `.meta` that could not be read — see `ui-write-tool.ts`). Unity also
 * accepts a bare project-relative path; it is slower to resolve (a path
 * lookup instead of a GUID lookup) and breaks if the file moves, but it is
 * exact right now, which the guid-based form cannot be without a guid.
 */
export function relativeStyleSrc(ussProjectPath: string): string {
  return escapeXmlAttr(ussProjectPath);
}
