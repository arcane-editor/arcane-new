/**
 * The design log, as data.
 *
 * The dock does not render a chat. It renders a record of what happened to the
 * document you are looking at: what you asked for, the direction the agent
 * committed to, and the files and measurements that followed. That shape is
 * not `AiMessage[]` — it is a flat list of rows with a column grammar — so the
 * mapping lives here, pure, where it can be tested without React or a store.
 *
 * It is also DOM-free, which is why the fallback label for an unrecognised tool
 * arrives as an injected `humanize` function rather than as a direct call to
 * `humanizeToolCall`: reaching that through the `ai-panel` barrel would drag in
 * `AiChatPanel` and the theme store, and the module would stop loading under
 * Bun at all — the same seam, and the same reason, as `todo-gates.ts`.
 *
 * The one interpretive step is the DIRECTION row. The design prompt requires
 * the model to open a turn with a single line naming the direction it is
 * taking, and this promotes that line. When the model does not comply, the
 * first line of its reply is still the lead sentence and reads correctly as
 * one — so the heuristic degrades into ordinary prose rather than into a wrong
 * claim.
 */

import type {
  AiMessage,
  PermissionOption,
  QuestionRequestData,
  ToolCallStatus,
} from '../../../stores/ai';

export type DesignRowStatus = 'pending' | 'running' | 'complete' | 'error';

export type DesignRow =
  /** What the user asked for. */
  | { kind: 'request'; id: string; text: string }
  /** The one-line art direction the turn is accountable to. */
  | { kind: 'direction'; id: string; text: string }
  /** Everything else the agent said. */
  | { kind: 'prose'; id: string; text: string }
  /** One action, in the log's three-column grammar. */
  | {
      kind: 'action';
      id: string;
      verb: string;
      subject: string;
      detail: string | null;
      status: DesignRowStatus;
    }
  /**
   * A turn that failed, was stopped, or a harness notice.
   *
   * `detail` and `raw` are carried, not dropped. The first version of this row
   * rendered `turnError.title` alone, so a failed design turn showed the word
   * "Server error" and nothing else — the provider's actual message was sitting
   * in the store and the one surface that had failed was the one surface that
   * would not show it. A failure the user cannot read is a failure nobody can
   * fix.
   */
  | {
      kind: 'notice';
      id: string;
      tone: 'error' | 'stopped' | 'system';
      text: string;
      detail: string | null;
      raw: string | null;
    }
  /**
   * What the closing pass MEASURED, which is the dock's whole payoff: the
   * document was rendered offscreen and its elements counted, rather than the
   * agent being taken at its word that the screen is fine.
   */
  | {
      kind: 'verified';
      id: string;
      elements: number | null;
      problems: number | null;
      /**
       * Elements no rule reaches. `null` when the card predates the count —
       * a restored session must not claim a zero it never measured.
       *
       * On this row because a screen is not finished when its geometry is
       * clean and nothing paints, and this dock is the surface where that
       * verdict matters most.
       */
      unstyled: number | null;
      files: number;
    }
  /**
   * A question the agent is BLOCKED on, and the permission it is blocked on.
   *
   * These two carry the loop's only unbounded waits — `ask_user` and every
   * engine-mutate approval hold the turn open with `timeoutMs: Infinity` until
   * a human answers. They were originally left to the AI panel "because it owns
   * their interactive affordances", which was exactly wrong: the person using
   * the dock is looking at the canvas, the panel may not even be open, and a
   * blocking prompt rendered somewhere they are not is a hung agent.
   */
  | {
      kind: 'question';
      id: string;
      toolCallId: string;
      question: string;
      options: { label: string; description?: string }[];
      answer: string | null;
      cancelled: boolean;
    }
  | {
      kind: 'permission';
      id: string;
      toolCallId: string;
      /** The one-line verb summary, e.g. "attach a UIDocument to Canvas". */
      detail: string;
      options: PermissionOption[];
      resolvedOptionId: string | null;
    };

/** Longer than this and an opening line is a paragraph, not a direction. */
const DIRECTION_MAX_CHARS = 160;

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value ? value : null;
}

/** `+34 −6`, from the diffs the edit-review decorator attached. */
function diffCounts(call: ToolCallStatus): string | null {
  if (!call.diffs || call.diffs.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const d of call.diffs) {
    const before = d.oldText ? d.oldText.split('\n').length : 0;
    const after = d.newText ? d.newText.split('\n').length : 0;
    if (after > before) added += after - before;
    else removed += before - after;
  }
  if (added === 0 && removed === 0) return null;
  // A minus sign, not a hyphen: the two columns line up in a proportional font
  // only if both signs have the same width.
  return `${added > 0 ? `+${added}` : ''}${added > 0 && removed > 0 ? ' ' : ''}${removed > 0 ? `−${removed}` : ''}`;
}

/** Produces the AI panel's own label for a tool this module has no column for. */
export type HumanizeFallback = (
  name: string,
  args: Record<string, unknown>,
  status?: ToolCallStatus,
) => string;

/**
 * The columnar form of one tool call.
 *
 * The design tools get a purpose-written vocabulary because their verbs are the
 * whole point of the log — "wrote", "laid out", "attached". Anything else falls
 * back to the injected label, which in the app is `humanizeToolCall`'s, rather
 * than growing a second half-complete table beside it.
 */
export function describeAction(
  call: { name: string; args: Record<string, unknown> },
  status?: ToolCallStatus,
  humanize?: HumanizeFallback,
): { verb: string; subject: string; detail: string | null } {
  const { name, args } = call;
  const counts = status ? diffCounts(status) : null;

  switch (name) {
    case 'unity_ui_write': {
      const path = str(args, 'path');
      return { verb: 'wrote', subject: path ? basename(path) : 'a UI file', detail: counts };
    }
    case 'write':
    case 'edit': {
      const path = str(args, 'path') ?? str(args, 'filePath');
      return {
        verb: name === 'write' ? 'wrote' : 'edited',
        subject: path ? basename(path) : 'a file',
        detail: counts,
      };
    }
    case 'unity_ui_layout': {
      const document = str(args, 'document');
      return { verb: 'laid out', subject: document ? basename(document) : 'the document', detail: null };
    }
    case 'unity_ui_toolkit':
      return { verb: 'read', subject: 'the UI Toolkit setup', detail: null };
    case 'unity_ui_scaffold': {
      const screen = str(args, 'screen');
      return { verb: 'drafted', subject: screen ? `a ${screen} screen` : 'a screen', detail: null };
    }
    case 'unity_attach_ui_document': {
      const gameObject = str(args, 'gameObject');
      return { verb: 'attached', subject: gameObject ?? 'the document', detail: 'UIDocument' };
    }
    case 'unity_set_property': {
      const property = str(args, 'property');
      return { verb: 'set', subject: property ?? 'a property', detail: str(args, 'component') };
    }
    case 'read': {
      const path = str(args, 'path') ?? str(args, 'filePath');
      return { verb: 'read', subject: path ? basename(path) : 'a file', detail: null };
    }
    default:
      return { verb: '', subject: humanize?.(name, args, status) ?? name, detail: null };
  }
}

/** Split an assistant text block into its opening line and the rest. */
function splitDirection(text: string): { direction: string | null; rest: string } {
  const trimmed = text.trim();
  if (!trimmed) return { direction: null, rest: '' };
  const breakAt = trimmed.indexOf('\n');
  const first = (breakAt === -1 ? trimmed : trimmed.slice(0, breakAt)).trim();
  // A heading, a list item or a code fence is structure, not a direction line.
  if (!first || first.length > DIRECTION_MAX_CHARS || /^[#\-*`>|]/.test(first)) {
    return { direction: null, rest: trimmed };
  }
  return { direction: first, rest: breakAt === -1 ? '' : trimmed.slice(breakAt + 1).trim() };
}

/**
 * Flatten the conversation into log rows.
 *
 * `toolCalls` is the live status map (`stores/ai.ts`), consulted for a running
 * call's state and for the diffs the review decorator attached once it lands.
 * `humanize` labels anything the column grammar does not cover; without it such
 * a row falls back to the raw tool name.
 */
export function buildDesignRows(
  messages: readonly AiMessage[],
  toolCalls: ReadonlyMap<string, ToolCallStatus>,
  humanize?: HumanizeFallback,
): DesignRow[] {
  const rows: DesignRow[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        if (message.text?.trim()) {
          rows.push({ kind: 'request', id: message.id, text: message.text.trim() });
        }
        break;

      case 'assistant': {
        // The direction is the opening line of the turn's FIRST text block.
        // Later blocks — the model resuming after a tool call — are prose.
        let wantsDirection = true;
        const blocks = message.content ?? [];
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          if (block.type === 'text') {
            if (!block.text?.trim()) continue;
            if (wantsDirection) {
              const { direction, rest } = splitDirection(block.text);
              if (direction) {
                rows.push({ kind: 'direction', id: `${message.id}:${i}:d`, text: direction });
              }
              if (rest) rows.push({ kind: 'prose', id: `${message.id}:${i}`, text: rest });
              wantsDirection = false;
            } else {
              rows.push({ kind: 'prose', id: `${message.id}:${i}`, text: block.text.trim() });
            }
          } else if (block.type === 'toolCall') {
            // A tool call means the turn has moved past its opening remarks.
            wantsDirection = false;
            const status = toolCalls.get(block.id);
            const { verb, subject, detail } = describeAction(
              { name: block.name, args: block.arguments ?? {} },
              status,
              humanize,
            );
            rows.push({
              kind: 'action',
              id: block.id,
              verb,
              subject,
              detail,
              status: status?.status ?? 'pending',
            });
          }
        }
        // A message that streamed only plain text carries it on `text`.
        if (blocks.length === 0 && message.text?.trim()) {
          const { direction, rest } = splitDirection(message.text);
          if (direction) rows.push({ kind: 'direction', id: `${message.id}:d`, text: direction });
          if (rest) rows.push({ kind: 'prose', id: message.id, text: rest });
        }
        break;
      }

      case 'error': {
        const error = message.turnError;
        const raw = error?.raw?.trim() ?? message.errorMessage?.trim() ?? null;
        const title = error?.title ?? message.errorMessage ?? 'The turn failed.';
        rows.push({
          kind: 'notice',
          id: message.id,
          tone: 'error',
          text: title,
          detail: error?.detail ?? null,
          // Only when it says something the title did not — a details toggle
          // that opens onto the same sentence is worse than no toggle.
          raw: raw && raw !== title ? raw : null,
        });
        break;
      }

      case 'stopped':
        rows.push({
          kind: 'notice',
          id: message.id,
          tone: 'stopped',
          text: 'Stopped.',
          detail: null,
          raw: null,
        });
        break;

      case 'questionRequest': {
        const q: QuestionRequestData | undefined = message.questionRequest;
        if (!q) break;
        rows.push({
          kind: 'question',
          id: message.id,
          toolCallId: q.toolCallId,
          question: q.question,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
          answer: q.resolvedAnswer ?? null,
          cancelled: !!q.cancelled,
        });
        break;
      }

      case 'permissionRequest': {
        const p = message.permissionRequest;
        if (!p) break;
        rows.push({
          kind: 'permission',
          id: message.id,
          toolCallId: p.toolCallId,
          // `detail` is the engine-approval verb summary; the file-write path
          // leaves it unset, so the tool name is the honest fallback rather
          // than a generic "an action".
          detail: p.detail ?? p.toolName ?? 'this action',
          options: p.options ?? [],
          resolvedOptionId: p.resolvedOptionId ?? null,
        });
        break;
      }

      case 'verifiedPass': {
        const data = message.verifiedPass;
        if (!data) break;
        const layout = data.layout;
        rows.push({
          kind: 'verified',
          id: message.id,
          // `null`, not 0: nothing was measured, which is a different claim
          // from "measured, and found nothing wrong".
          elements: layout && layout !== 'skipped' ? layout.elements : null,
          problems: layout && layout !== 'skipped' ? layout.problems : null,
          unstyled: layout && layout !== 'skipped' ? (layout.unstyled ?? null) : null,
          files: data.files,
        });
        break;
      }

      case 'system':
        if (message.text?.trim()) {
          rows.push({
            kind: 'notice',
            id: message.id,
            tone: 'system',
            text: message.text.trim(),
            detail: null,
            raw: null,
          });
        }
        break;

      default:
        // `toolResult` only — its content is already rendered on the action row
        // that produced it.
        break;
    }
  }

  return rows;
}

/**
 * What to say under the log while a turn is live that the log does not already
 * say — `null` when there is nothing to add.
 *
 * The named work ("laying out MainMenu.uxml") lives on the ACTION ROW, which
 * has the spinner. This line exists for the one state the rows cannot show: a
 * turn that is running with no tool call in flight, at the start of a turn or
 * between two of them. That is a real state, not a placeholder.
 */
export function designStatusLine(rows: readonly DesignRow[], running: boolean): string | null {
  if (!running) return null;
  const tail = rows[rows.length - 1];
  // A running action row already carries its own spinner and says what it is —
  // repeating it underneath reads as a duplicate, not as a status.
  if (tail?.kind === 'action' && (tail.status === 'running' || tail.status === 'pending')) {
    return null;
  }
  return 'Thinking…';
}
