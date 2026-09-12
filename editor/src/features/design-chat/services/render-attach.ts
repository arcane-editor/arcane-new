/**
 * Whether the latest render rides along with the next message.
 *
 * **Why the model needs it at all.** The brief (`design-brief.ts`) tells it the
 * markup, the rules and the coverage counts — everything about the screen
 * except what it looks like. "Make the buttons feel heavier" is a judgement
 * about a picture, and the harness had no way to show one.
 *
 * **Why it has to ride on the user message.** A tool cannot hand an image back.
 * `agent-loop.ts` filters tool-result content to text before the message the
 * model sees is built, `openai-format.ts` does it again, and the server's
 * `role:'tool'` shape has no image variant at all. Images survive only on a
 * user turn, which is fully plumbed end to end.
 *
 * **Why it is skippable.** Whether the routed model accepts images is not
 * something this editor knows: the server picks the model per tier, and there
 * is no published vision capability to check. Attaching one to every design
 * send would turn an unknown into a hard failure on every turn if the answer is
 * no, so `attachRender` remains as the escape hatch.
 *
 * **The render is no longer shown to the USER**, only sent to the model. The
 * dock used to display it and carry the opt-out next to it; the `.uxml`
 * preview behind the dock shows the same screen, live, so a second copy in the
 * transcript was showing the user what they were already looking at. The model
 * has no such view, which is why the attachment stayed.
 */

import type { Attachment } from '../../ai-panel';
import type { DesignRender } from '../../../stores/design-chat';

export interface RenderAttachInput {
  render: DesignRender | null;
  /** What the user has staged themselves for this message. */
  staged: readonly Attachment[];
  /** The dock's own preference — false once the user has turned it off. */
  enabled: boolean;
}

/**
 * The image attachment to append, or null to send nothing extra.
 *
 * Null when: the feature is off, there is no render, the capture failed
 * (`renderToPng` returns null rather than a blank frame), the model has
 * already been shown this exact render, or the user staged an image of their
 * own. That last one is deliberate — "make it look like this" is a request
 * about THEIR picture, and a second image with no way to label which is which
 * makes it a worse prompt, not a richer one. The brief still describes the
 * current screen in words on that turn.
 */
export function renderAttachment(input: RenderAttachInput): Attachment | null {
  const { render, staged, enabled } = input;
  if (!enabled || !render?.dataUrl || render.sent) return null;
  if (staged.some((a) => a.kind === 'image')) return null;

  return {
    kind: 'image',
    id: `design-render-${render.at}`,
    dataUrl: render.dataUrl,
    mimeType: 'image/png',
    sourceLabel: `${basename(render.documentPath)} as it renders now`,
  };
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}
