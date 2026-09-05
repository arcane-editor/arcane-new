import { describe, expect, it } from 'bun:test';
import { renderAttachment, renderAttachNote } from './render-attach';
import type { DesignRender } from '../../../stores/design-chat';
import type { Attachment } from '../../ai-panel';

function render(over: Partial<DesignRender> = {}): DesignRender {
  return {
    documentPath: 'Assets/UI/MainMenu.uxml',
    dataUrl: 'data:image/png;base64,AAAA',
    at: 1700000000000,
    sent: false,
    ...over,
  };
}

const USER_IMAGE: Attachment = {
  kind: 'image',
  id: 'u1',
  dataUrl: 'data:image/png;base64,BBBB',
  mimeType: 'image/png',
  sourceLabel: 'stitch-reference.png',
};

const FILE: Attachment = {
  kind: 'file',
  id: 'f1',
  path: '/ws/Assets/UI/Theme.uss',
  relPath: 'Assets/UI/Theme.uss',
  bytes: 900,
};

describe('renderAttachment', () => {
  it('attaches the render, labelled so the transcript says what it is', () => {
    const out = renderAttachment({ render: render(), staged: [], enabled: true });
    expect(out?.kind).toBe('image');
    expect(out).toMatchObject({ mimeType: 'image/png' });
    expect(out && 'sourceLabel' in out ? out.sourceLabel : '').toBe(
      'MainMenu.uxml as it renders now',
    );
  });

  it('sends nothing when the user turned it off', () => {
    expect(renderAttachment({ render: render(), staged: [], enabled: false })).toBeNull();
  });

  it('sends nothing when the capture failed', () => {
    // `renderToPng` returns null rather than a blank frame, and a blank frame
    // handed to a model is worse than no image: it gets described.
    expect(
      renderAttachment({ render: render({ dataUrl: null }), staged: [], enabled: true }),
    ).toBeNull();
  });

  it('does not send the same render twice', () => {
    expect(renderAttachment({ render: render({ sent: true }), staged: [], enabled: true })).toBeNull();
  });

  it('stands aside for the user’s own reference image', () => {
    // "Make it look like this" is a request about THEIR picture; a second image
    // with no way to say which is which makes it a worse prompt.
    expect(
      renderAttachment({ render: render(), staged: [USER_IMAGE], enabled: true }),
    ).toBeNull();
  });

  it('still attaches alongside a non-image attachment', () => {
    expect(renderAttachment({ render: render(), staged: [FILE], enabled: true })).not.toBeNull();
  });

  it('sends nothing before the first render exists', () => {
    expect(renderAttachment({ render: null, staged: [], enabled: true })).toBeNull();
  });
});

describe('renderAttachNote', () => {
  it('says it before it happens', () => {
    expect(renderAttachNote({ render: render(), staged: [], enabled: true })).toContain(
      'goes with this message',
    );
  });

  it('stays quiet in every case where nothing is attached', () => {
    expect(renderAttachNote({ render: render(), staged: [], enabled: false })).toBeNull();
    expect(renderAttachNote({ render: null, staged: [], enabled: true })).toBeNull();
    expect(renderAttachNote({ render: render({ sent: true }), staged: [], enabled: true })).toBeNull();
  });
});
