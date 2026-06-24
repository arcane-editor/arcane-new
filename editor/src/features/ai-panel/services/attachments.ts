/**
 * Attachment resolution — turns staged Attachments into model-facing content.
 *
 * Phase 4 supports file + unity-doc as text content prepended to the user's
 * message. Phase 5 will branch image attachments into multi-part content
 * blocks (text + image_url) via a vendor-patched Agent.promptStructured().
 */

import { invoke } from '@tauri-apps/api/core';
import type { Attachment } from './types';
import { bridgeRpc, type HierarchyNode } from '../../unity-bridge';
import { useUnityStore } from '../../../stores/unity';
import { useUnitySceneStore } from '../../../stores/unity-scene';

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
    const sel = await bridgeRpc.getSelection().catch(() => ({ objects: [] }));
    const body = sel.objects.length
      ? sel.objects.map((o) => `${o.name} (${o.type}) — ${o.path}`).join('\n')
      : '(nothing selected in the Editor)';
    return `<unity-selection>\n${capBlock(body)}\n</unity-selection>`;
  }

  // scene / hierarchy
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
  if (!useUnityStore.getState().connected) return null;
  const go = await bridgeRpc
    .getGameObject(instanceId != null ? { instanceId } : { path: name })
    .catch(() => null);
  if (!go) return null;
  return `<unity-object name="${escapeAttr(name)}">\n${capBlock(JSON.stringify(go, null, 1))}\n</unity-object>`;
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
