/**
 * Pure translation between ACP's vocabulary and the chat panel's.
 *
 * Everything here is a total function over untrusted input: an agent is a
 * separate program on a release cycle we do not control, so every one of these
 * must degrade rather than throw when it meets a shape it has not seen. That
 * is why the ACP-side parameters are typed loosely and every switch has a
 * default.
 *
 * Keeping it free of stores and Tauri also makes it the one part of the
 * external-agent path that is exhaustively unit-testable.
 */

import type {
  AcpPlanEntry,
  AcpStopReason,
  AcpToolCallStatus,
  ContentBlock,
  ToolCallContent,
  ToolCallUpdate,
} from '../../acp';
import type { ArcanePlanEntry, ToolCallStatus } from '../../../stores/ai';
import type { DiffContent, StopReason } from './vendor/types';

/**
 * Flatten ACP content into the plain text the message list renders.
 *
 * Non-text blocks (images, resource links) are summarised rather than dropped
 * silently — a turn whose only output was an image should not look empty.
 */
export function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;

  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];

  for (const raw of blocks) {
    if (typeof raw === 'string') {
      parts.push(raw);
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as ContentBlock & { text?: string; name?: string; uri?: string };

    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'audio':
        parts.push('[audio]');
        break;
      case 'resource_link':
        parts.push(block.name ?? block.uri ?? '[resource]');
        break;
      case 'resource': {
        const resource = (block as { resource?: { text?: string; uri?: string } }).resource;
        if (typeof resource?.text === 'string') parts.push(resource.text);
        else if (resource?.uri) parts.push(resource.uri);
        break;
      }
      default:
        // An unknown block type from a newer agent. Prefer any text it happens
        // to carry over inventing a placeholder for something we can't name.
        if (typeof block.text === 'string') parts.push(block.text);
        break;
    }
  }

  return parts.join('');
}

/**
 * Pull renderable file diffs out of a tool call's content.
 *
 * ACP allows `oldText: null` for a newly created file; the panel's `DiffBlock`
 * wants a string, and '' is the honest representation of "there was nothing
 * here before".
 */
export function extractDiffs(content: ToolCallContent[] | undefined): DiffContent[] {
  if (!Array.isArray(content)) return [];
  const out: DiffContent[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    if ((entry as { type?: string }).type !== 'diff') continue;
    const diff = entry as { path?: unknown; oldText?: unknown; newText?: unknown };
    if (typeof diff.path !== 'string' || typeof diff.newText !== 'string') continue;
    out.push({
      path: diff.path,
      oldText: typeof diff.oldText === 'string' ? diff.oldText : '',
      newText: diff.newText,
    });
  }
  return out;
}

/** Every terminal id embedded in a tool call's content. */
export function extractTerminalIds(content: ToolCallContent[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (e): e is { type: 'terminal'; terminalId: string } =>
        !!e &&
        typeof e === 'object' &&
        (e as { type?: string }).type === 'terminal' &&
        typeof (e as { terminalId?: unknown }).terminalId === 'string',
    )
    .map((e) => e.terminalId);
}

/**
 * ACP tool statuses → the panel's.
 *
 * An absent status means "no change" to the caller, so it maps to `running`
 * only at the point a tool call first appears; `tool_call_update` handles the
 * undefined case itself rather than forcing a value here.
 */
export function toolStatusFor(status: AcpToolCallStatus | string | undefined): ToolCallStatus['status'] {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'complete';
    case 'failed':
      return 'error';
    default:
      // A status we don't recognise is still a live tool call — showing it as
      // running is recoverable, showing it as complete would lie.
      return 'running';
  }
}

/**
 * ACP stop reasons → the panel's.
 *
 * `refusal` maps to a plain stop rather than an error: the agent completed its
 * turn and said no, which is a valid outcome, not a failure to render as one.
 */
export function stopReasonFor(reason: AcpStopReason | string | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'refusal':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'max_turn_requests':
      return 'toolUse';
    case 'cancelled':
      return 'aborted';
    default:
      return 'stop';
  }
}

/** ACP plan entries → the panel's todo list. */
export function planEntriesFor(entries: AcpPlanEntry[] | undefined): ArcanePlanEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && typeof e.content === 'string')
    .map((e) => ({
      text: e.content,
      status:
        e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending',
    }));
}

/**
 * A human label for a tool call.
 *
 * The agent's own `title` is preferred because it is written for a person
 * ("Read src/Player.cs"); `kind` is a coarse fallback and 'tool' is the last
 * resort. `humanizeToolCall` in the panel already knows to pass an unfamiliar
 * name through unchanged, so this never has to guess further.
 */
export function toolDisplayName(update: Pick<ToolCallUpdate, 'title' | 'kind'>): string {
  return update.title?.trim() || update.kind?.trim() || 'tool';
}

/**
 * Split a `data:` URL into the raw base64 ACP expects.
 *
 * ACP image blocks carry bare base64 plus a separate `mimeType`; sending the
 * whole data URL through produces an image the agent silently fails to decode.
 */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * Reconcile what we already show for a tool call against a fresh update.
 *
 * ACP tool calls open BEFORE their arguments exist: the live adapter opens a
 * shell call as `{ title: "Terminal", rawInput: {} }` and only fills in the
 * real command in a later `tool_call_update`, once the model has finished
 * streaming the tool's input. Rendering the first label and never revisiting it
 * leaves every shell call reading "Terminal" with no command attached.
 *
 * Returns `changed: false` when the update tells us nothing new, so the caller
 * can skip a needless re-render.
 */
export function reconcileToolCall(
  update: Pick<ToolCallUpdate, 'title' | 'kind' | 'rawInput'>,
  known: { name?: string; args?: Record<string, unknown> },
): { name: string; args: Record<string, unknown>; changed: boolean } {
  const name = update.title || known.name || toolDisplayName(update);
  const incoming =
    update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : {};
  // An update WITHOUT `rawInput` does not mean "the arguments are now empty" —
  // it is an update about something else (status, output). Keep the last ones.
  const hasNewArgs = Object.keys(incoming).length > 0;
  const args = hasNewArgs ? incoming : (known.args ?? {});
  return { name, args, changed: name !== known.name || (hasNewArgs && args !== known.args) };
}
