/**
 * Attachment resolution — turns staged Attachments into model-facing content.
 *
 * Phase 4 supports file + unity-doc as text content prepended to the user's
 * message. Phase 5 will branch image attachments into multi-part content
 * blocks (text + image_url) via a vendor-patched Agent.promptStructured().
 *
 * Store/bridge imports below are deliberately dynamic (`await import(...)`
 * inside the functions that need them) rather than static top-of-file
 * imports. A static import of `stores/unity`, `stores/unity-scene`,
 * `stores/unity-index`, or the `unity-bridge` barrel's runtime export
 * transitively reaches `stores/workspace` → `stores/ai` → the `ai-panel`
 * barrel → `stores/theme`, whose `create()` initializer touches `document`
 * at module-eval time — a crash under `bun test`'s no-DOM environment
 * (verified: even importing an unrelated existing export of this file was
 * enough to crash before this change). Keeping this file's top level free of
 * runtime store imports means the pure formatters below (e.g.
 * `formatUnityAssetBlock`) can be unit-tested in isolation. Same pattern as
 * `summarize-scene-diff.ts`.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Attachment } from './types';
import type { HierarchyNode } from '../../unity-bridge';

const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_FILE_BYTES = 500 * 1024;

export interface ResolvedAttachments {
  /** Text block to prepend to the user's prompt. Empty string if no text-bearing attachments. */
  prefix: string;
  /** Image attachments preserved for the multi-part path (Phase 5). */
  images: Extract<Attachment, { kind: 'image' }>[];
  /** Notes for the user (e.g. "PlayerController.cs truncated to 200KB"). */
  warnings: string[];
}

export async function resolveAttachments(
  attachments: Attachment[],
): Promise<ResolvedAttachments> {
  if (attachments.length === 0) {
    return { prefix: '', images: [], warnings: [] };
  }

  const blocks: string[] = [];
  const warnings: string[] = [];
  const images: Extract<Attachment, { kind: 'image' }>[] = [];
  let totalBytes = 0;

  for (const a of attachments) {
    if (a.kind === 'image') {
      images.push(a);
      continue;
    }

    if (a.kind === 'pasted-text') {
      // Fenced, so the model reads it as a quoted artefact rather than as part
      // of the user's sentence — which is exactly the distinction the chip
      // makes visually in the composer.
      blocks.push(`Pasted content (${a.lineCount} lines):\n\n\`\`\`\n${a.text}\n\`\`\``);
      totalBytes += a.text.length;
      continue;
    }

    if (a.kind === 'unity-context') {
      const block = await resolveUnityContext(a.verb);
      if (block) blocks.push(block);
      else warnings.push(`@${a.verb}: Unity not connected — live ${a.verb} unavailable.`);
      continue;
    }

    if (a.kind === 'unity-object') {
      const block = await resolveUnityObject(a.name, a.instanceId);
      if (block) blocks.push(block);
      else warnings.push(`@object(${a.name}): unavailable (Unity not connected?).`);
      continue;
    }

    if (a.kind === 'unity-asset') {
      blocks.push(await resolveUnityAsset(a.path, a.relPath, a.guid));
      continue;
    }

    if (a.kind === 'unity-doc') {
      blocks.push(
        `<unity-doc name="${escapeAttr(a.name)}" url="${escapeAttr(a.url)}"${
          a.category ? ` category="${escapeAttr(a.category)}"` : ''
        } />`,
      );
      continue;
    }

    // file
    if (totalBytes >= MAX_TOTAL_FILE_BYTES) {
      warnings.push(`Skipped \`${a.relPath}\` — total attachment size limit reached.`);
      continue;
    }

    let content: string;
    try {
      content = await invoke<string>('read_file', { path: a.path });
    } catch (err) {
      warnings.push(`Could not read \`${a.relPath}\`: ${formatErr(err)}`);
      continue;
    }

    const remaining = MAX_TOTAL_FILE_BYTES - totalBytes;
    const perFileCap = Math.min(MAX_FILE_BYTES, remaining);

    let truncated = false;
    let snippet = content;
    if (byteLength(snippet) > perFileCap) {
      snippet = truncateToBytes(snippet, perFileCap);
      truncated = true;
    }

    totalBytes += byteLength(snippet);

    blocks.push(
      `<file path="${escapeAttr(a.relPath)}">\n${snippet}${
        truncated ? `\n… (truncated to ${Math.round(perFileCap / 1024)}KB)` : ''
      }\n</file>`,
    );

    if (truncated) {
      warnings.push(
        `\`${a.relPath}\` was truncated to ${Math.round(perFileCap / 1024)}KB.`,
      );
    }
  }

  const prefix = blocks.length > 0 ? `<attachments>\n${blocks.join('\n\n')}\n</attachments>\n\n` : '';
  return { prefix, images, warnings };
}

/** Encode an image File/Blob (from paste/drop) into a data URL. */
/**
 * What an image-only send says.
 *
 * An image attachment contributes NO text prefix — `resolveAttachments` puts it
 * straight into `images` — so a send with pictures and no typed words produced
 * `{ type: 'text', text: '' }` as its first content part. Providers reject an
 * empty content part, deterministically, and the client retries a rejection
 * that will never succeed: the turn sits on "Thinking…" through the backoff and
 * then surfaces the server's generic `model_error` as a bare "Server error".
 *
 * The AI panel could never reach this — its composer requires text — so this is
 * specifically the design dock's case, where sending a reference image on its
 * own is a complete request.
 */
export function promptTextForImages(text: string, imageCount: number): string {
  const trimmed = text.trim();
  if (trimmed) return text;
  if (imageCount === 0) return text;
  return imageCount === 1
    ? 'Use the attached image as the visual reference for this screen.'
    : `Use the ${imageCount} attached images as the visual reference for this screen.`;
}

export function encodeImageFromBlob(
  blob: Blob,
): Promise<{ dataUrl: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve({ dataUrl, mimeType: blob.type || 'image/png' });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── Unity live-context resolvers (F-5.5) ─────────────────────────────────────

const UNITY_BLOCK_CAP = 6 * 1024;

function capBlock(s: string): string {
  return byteLength(s) > UNITY_BLOCK_CAP
    ? truncateToBytes(s, UNITY_BLOCK_CAP) + '\n…(truncated)'
    : s;
}

function formatNodeText(n: HierarchyNode, depth: number, maxDepth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const comps = n.components.map((c) => c.type).join(', ');
  out.push(`${indent}${n.name}${n.active ? '' : ' (inactive)'} [${comps || 'no components'}]`);
  if (depth < maxDepth) for (const c of n.children) formatNodeText(c, depth + 1, maxDepth, out);
  else if (n.children.length > 0) out.push(`${indent}  …${n.children.length} more`);
}

async function resolveUnityContext(
  verb: 'scene' | 'selection' | 'hierarchy' | 'console',
): Promise<string | null> {
  const { useUnityStore } = await import('../../../stores/unity');

  // @console reads the local log ring — works offline.
  if (verb === 'console') {
    const errs = useUnityStore
      .getState()
      .logs.filter((l) => ['Error', 'Exception', 'Assert'].includes(l.logType))
      .slice(-30);
    const body = errs.length
      ? errs.map((l) => `[${l.logType}] ${l.message}`).join('\n')
      : '(no errors captured this session)';
    return `<unity-console>\n${capBlock(body)}\n</unity-console>`;
  }

  if (!useUnityStore.getState().connected) return null;

  if (verb === 'selection') {
    const { bridgeRpc } = await import('../../unity-bridge');
    const sel = await bridgeRpc.getSelection().catch(() => ({ objects: [] }));
    const body = sel.objects.length
      ? sel.objects.map((o) => `${o.name} (${o.type}) — ${o.path}`).join('\n')
      : '(nothing selected in the Editor)';
    return `<unity-selection>\n${capBlock(body)}\n</unity-selection>`;
  }

  // scene / hierarchy
  const { useUnitySceneStore } = await import('../../../stores/unity-scene');
  const h = await useUnitySceneStore.getState().ensureFresh().catch(() => null);
  if (!h) return null;
  const maxDepth = verb === 'hierarchy' ? 2 : 6;
  const out: string[] = [];
  for (const scene of h.scenes) {
    out.push(`# ${scene.name}`);
    for (const root of scene.roots) formatNodeText(root, 0, maxDepth, out);
  }
  return `<unity-${verb}>\n${capBlock(out.join('\n') || '(no open scenes)')}\n</unity-${verb}>`;
}

async function resolveUnityObject(name: string, instanceId?: number): Promise<string | null> {
  const { useUnityStore } = await import('../../../stores/unity');
  if (!useUnityStore.getState().connected) return null;
  const { bridgeRpc } = await import('../../unity-bridge');
  const go = await bridgeRpc
    .getGameObject(instanceId != null ? { instanceId } : { path: name })
    .catch(() => null);
  if (!go) return null;
  return `<unity-object name="${escapeAttr(name)}">\n${capBlock(JSON.stringify(go, null, 1))}\n</unity-object>`;
}

// ── Unity asset attachment (P5.4) ────────────────────────────────────────────
// Structured summary of a Unity YAML asset (scene/prefab/material/etc.) parsed
// via the Rust `unity_parse_asset` command — GameObject→component tree for
// scenes/prefabs, or a document/property list for materials/.asset/.anim/
// .controller — plus a reverse-reference count from the GUID index. These
// types mirror the camelCase shape `unity_parse_asset` returns (see
// `unity_yaml.rs` / `unity-asset-viewer/services/asset-model.ts`); duplicated
// locally rather than imported cross-feature since unity-asset-viewer only
// exports React components, no pure text formatter to reuse.

interface UnityAssetComponentRef {
  typeName: string;
}

interface UnityAssetGameObject {
  name: string;
  isActive: boolean;
  components: UnityAssetComponentRef[];
  children: UnityAssetGameObject[];
}

interface UnityAssetDocument {
  typeName: string;
  properties: Array<[string, string]>;
}

export interface UnityAssetModel {
  documents: UnityAssetDocument[];
  gameObjects: UnityAssetGameObject[];
}

const UNITY_ASSET_BLOCK_CAP = 8 * 1024;
const UNITY_ASSET_MAX_NODES = 40;
const UNITY_ASSET_MAX_DOC_PROPS = 8;

async function resolveUnityAsset(path: string, relPath: string, guid: string): Promise<string> {
  let model: UnityAssetModel | null = null;
  let parseError: string | null = null;
  try {
    model = await invoke<UnityAssetModel>('unity_parse_asset', { path });
  } catch (err) {
    parseError = formatErr(err);
  }

  const { useUnityIndexStore } = await import('../../../stores/unity-index');
  const refs = await useUnityIndexStore.getState().findReferences(guid);

  return formatUnityAssetBlock({ relPath, model, parseError, refCount: refs.length });
}

/** First-N-nodes GameObject→component tree, or a document/property summary
 *  for asset types with no GameObject hierarchy (materials, .asset, etc.). */
function formatAssetTree(model: UnityAssetModel): string {
  if (model.gameObjects.length > 0) {
    const lines: string[] = [];
    let count = 0;
    let truncated = false;
    const walk = (go: UnityAssetGameObject, depth: number) => {
      if (truncated) return;
      if (count >= UNITY_ASSET_MAX_NODES) {
        truncated = true;
        return;
      }
      count++;
      const indent = '  '.repeat(depth);
      const comps = go.components.map((c) => c.typeName).join(', ');
      lines.push(`${indent}${go.name}${go.isActive ? '' : ' (inactive)'}${comps ? ` [${comps}]` : ''}`);
      for (const child of go.children) {
        if (truncated) break;
        walk(child, depth + 1);
      }
    };
    for (const go of model.gameObjects) {
      if (truncated) break;
      walk(go, 0);
    }
    if (truncated) lines.push(`…(truncated at ${UNITY_ASSET_MAX_NODES} nodes)`);
    return lines.join('\n');
  }

  if (model.documents.length > 0) {
    const lines: string[] = [];
    for (const doc of model.documents.slice(0, UNITY_ASSET_MAX_NODES)) {
      lines.push(doc.typeName);
      for (const [k, v] of doc.properties.slice(0, UNITY_ASSET_MAX_DOC_PROPS)) {
        const val = v.length > 120 ? v.slice(0, 120) + '…' : v;
        lines.push(`  ${k}: ${val}`);
      }
    }
    return lines.join('\n');
  }

  return '(empty asset — no structured content)';
}

/**
 * Format a parsed Unity asset (or a parse failure) into a `<unity-asset>`
 * text block for the prompt prefix. Pure — no I/O, no store reads. Capped to
 * ~8KB; the reference-count line is always preserved (reserved before the
 * body is truncated) so a huge asset never silently drops it.
 */
export function formatUnityAssetBlock(params: {
  relPath: string;
  model: UnityAssetModel | null;
  parseError?: string | null;
  refCount: number;
}): string {
  const { relPath, model, parseError, refCount } = params;

  if (!model || parseError) {
    return `<unity-asset path="${escapeAttr(relPath)}">\ncould not parse asset — path only\n</unity-asset>`;
  }

  const refLine = `referenced by ${refCount} asset${refCount === 1 ? '' : 's'}`;
  const reserve = byteLength(refLine) + 2; // blank line before the ref count
  const bodyCap = Math.max(0, UNITY_ASSET_BLOCK_CAP - reserve);

  let body = formatAssetTree(model);
  if (byteLength(body) > bodyCap) {
    body = truncateToBytes(body, bodyCap) + '\n…(truncated)';
  }

  return `<unity-asset path="${escapeAttr(relPath)}">\n${body}\n\n${refLine}\n</unity-asset>`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function truncateToBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = enc.encode(s);
  if (buf.length <= maxBytes) return s;
  // Decode with `fatal: false` and avoid splitting a multi-byte char by
  // letting the decoder discard a partial trailing sequence.
  return dec.decode(buf.slice(0, maxBytes), { stream: false });
}
