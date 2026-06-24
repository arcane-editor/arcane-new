/**
 * MentionNode — Lexical TextNode subclass that renders as a styled chip.
 *
 * The chip's text is its label (e.g. "@PlayerController.cs"); the actual
 * attachment payload (path / URL / etc.) lives in the AI store, addressed by
 * `attachmentId`. When the user deletes the chip, we clear the corresponding
 * attachment in the parent component's `clearAttachments()` cleanup.
 *
 * Why TextNode (not DecoratorNode)?
 *  - Text content is naturally included in `$getRoot().getTextContent()` so the
 *    AI sees the @-mention inline with the rest of the prompt.
 *  - Backspace at the right edge removes the whole chip (atomic via
 *    `setMode('token')`).
 */

import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type SerializedTextNode,
  type Spread,
  type NodeKey,
} from 'lexical';

export type MentionKind = 'file' | 'unity-doc' | 'unity-context' | 'unity-object';

export interface MentionPayload {
  kind: MentionKind;
  attachmentId: string;
  label: string;
}

export type SerializedMentionNode = Spread<
  {
    type: 'mention';
    version: 1;
    mentionKind: MentionKind;
    attachmentId: string;
    label: string;
  },
  SerializedTextNode
>;

export class MentionNode extends TextNode {
  __mentionKind: MentionKind;
  __attachmentId: string;
  __label: string;

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(
      {
        kind: node.__mentionKind,
        attachmentId: node.__attachmentId,
        label: node.__label,
      },
      node.__key,
    );
  }

  constructor(payload: MentionPayload, key?: NodeKey) {
    super(`@${payload.label}`, key);
    this.__mentionKind = payload.kind;
    this.__attachmentId = payload.attachmentId;
    this.__label = payload.label;
  }

  /** The chip is atomic — selection lands on either side, never inside. */
  isToken(): true {
    return true;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.classList.add('lexical-mention-chip');
    dom.classList.add(`lexical-mention-chip--${this.__mentionKind}`);
    dom.setAttribute('data-attachment-id', this.__attachmentId);
    return dom;
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    return $createMentionNode({
      kind: serialized.mentionKind,
      attachmentId: serialized.attachmentId,
      label: serialized.label,
    });
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: 'mention',
      version: 1,
      mentionKind: this.__mentionKind,
      attachmentId: this.__attachmentId,
      label: this.__label,
    };
  }

  get attachmentId(): string {
    return this.__attachmentId;
  }
}

export function $createMentionNode(payload: MentionPayload): MentionNode {
  const node = new MentionNode(payload);
  return $applyNodeReplacement(node);
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}
