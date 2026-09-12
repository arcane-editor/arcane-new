import { describe, it, expect, beforeEach } from 'bun:test';
import {
  withLayoutGate,
  formatLayoutFindings,
  formatLayoutUnmeasured,
  type LayoutGateDeps,
  type LayoutGateReport,
} from './layout-gate';
import type { AgentTool, AgentToolResult } from '../vendor/types';

const WS = '/proj';
const DOC = 'Assets/UI/MainMenu.uxml';

function tool(result: AgentToolResult): AgentTool {
  return {
    name: 'unity_ui_write',
    label: 'unity ui write',
    description: '',
    parameters: { type: 'object' } as never,
    execute: async () => result,
  };
}

function wrote(path: string): AgentToolResult {
  return { content: [{ type: 'text', text: `Wrote ${path} (guid abc).` }] };
}

/** Every render the gate published, so a test can assert what the dock was told. */
const published: Array<{ documentPath: string; dataUrl: string | null }> = [];

beforeEach(() => {
  published.length = 0;
});

function deps(report: LayoutGateReport | null, onCall?: () => void): LayoutGateDeps {
  return {
    probe: async () => {
      onCall?.();
      return report;
    },
    onRender: (documentPath, dataUrl) => published.push({ documentPath, dataUrl }),
  };
}

function textOf(res: AgentToolResult): string {
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

const CLEAN: LayoutGateReport = { problems: [], elements: 14, styling: null, image: null };
const BROKEN: LayoutGateReport = {
  problems: ['zero-size: #play-button laid out at 0 × 0'],
  elements: 14,
  styling: null,
  image: null,
};

async function run(
  path: string,
  result: AgentToolResult,
  d: LayoutGateDeps,
  target: string | null = DOC,
): Promise<string> {
  const gated = withLayoutGate(tool(result), WS, () => target, d);
  return textOf(await gated.execute('id', { path, content: 'x' }));
}

describe('withLayoutGate', () => {
  it('says nothing when the document lays out cleanly', async () => {
    const out = await run(DOC, wrote(DOC), deps(CLEAN));
    expect(out).not.toContain('[Unity layout]');
  });

  it('reports a geometry problem the string checks cannot see', async () => {
    const out = await run(DOC, wrote(DOC), deps(BROKEN));
    expect(out).toContain('[Unity layout]');
    expect(out).toContain('zero-size');
    expect(out).toContain('fix them before finishing');
  });

  it('probes the SESSION document after a stylesheet write, not the file written', async () => {
    // A `.uss` write changes the layout of the document that references it,
    // which is the commonest way a screen collapses.
    let probed = 0;
    const out = await run('Assets/UI/Theme.uss', wrote('Assets/UI/Theme.uss'), deps(BROKEN, () => probed++));
    expect(probed).toBe(1);
    expect(out).toContain(DOC);
  });

  it('says the geometry is UNCHECKED when it could not be measured', async () => {
    // Global Constraint 2: a degraded read must never read as a clean one.
    const out = await run(DOC, wrote(DOC), deps(null));
    expect(out).toContain('UNCHECKED');
    expect(out).not.toContain('fix them before finishing');
  });

  it('ignores a write to anything that is not UI markup', async () => {
    let probed = 0;
    await run('Assets/Scripts/Menu.cs', wrote('Assets/Scripts/Menu.cs'), deps(BROKEN, () => probed++));
    expect(probed).toBe(0);
  });

  it('probes nothing when no design session is live', async () => {
    let probed = 0;
    await run(DOC, wrote(DOC), deps(BROKEN, () => probed++), null);
    expect(probed).toBe(0);
  });

  it('leaves a rejected write alone', async () => {
    let probed = 0;
    const rejected: AgentToolResult = {
      content: [{ type: 'text', text: 'User rejected the write to Assets/UI/MainMenu.uxml.' }],
    };
    const out = await run(DOC, rejected, deps(BROKEN, () => probed++));
    expect(probed).toBe(0);
    expect(out).not.toContain('[Unity layout]');
  });

  it('reports an unstyled screen that lays out perfectly', async () => {
    // The complaint this gate was extended for: every box the right size, the
    // geometry lint silent, and the screen renders as flat default grey.
    const unstyled: LayoutGateReport = {
      problems: [],
      elements: 14,
      image: null,
      styling: 'MainMenu.uxml references no stylesheet, so every one of its 14 elements renders with Unity default styling.',
    };
    const out = await run(DOC, wrote(DOC), deps(unstyled));
    expect(out).toContain('[Unity styling]');
    expect(out).toContain('references no stylesheet');
    // Geometry was clean, so it must not claim otherwise.
    expect(out).not.toContain('[Unity layout]');
  });

  it('keeps geometry and styling as separate labelled blocks', async () => {
    const both: LayoutGateReport = {
      problems: ['zero-size: #play-button laid out at 0 × 0'],
      elements: 14,
      image: null,
      styling: '9 of 14 elements matched no rule.',
    };
    const out = await run(DOC, wrote(DOC), deps(both));
    expect(out).toContain('[Unity layout]');
    expect(out).toContain('[Unity styling]');
    // Different problems with different fixes; the model should not have to
    // disentangle a flex bug from a missing rule inside one paragraph.
    expect(out.indexOf('[Unity layout]')).toBeLessThan(out.indexOf('[Unity styling]'));
  });

  it('publishes the render so the dock can show what the turn made', async () => {
    const withImage: LayoutGateReport = { ...CLEAN, image: 'data:image/png;base64,AAAA' };
    await run(DOC, wrote(DOC), deps(withImage));
    expect(published).toEqual([{ documentPath: DOC, dataUrl: 'data:image/png;base64,AAAA' }]);
  });

  it('publishes a null render rather than leaving the last one standing', async () => {
    // The dock showing the PREVIOUS turn's picture beside this turn's writes
    // would answer "what did that do" with the wrong screen.
    await run(DOC, wrote(DOC), deps(CLEAN));
    expect(published).toEqual([{ documentPath: DOC, dataUrl: null }]);
  });

  it('publishes a null render when the document could not be measured at all', async () => {
    await run(DOC, wrote(DOC), deps(null));
    expect(published).toEqual([{ documentPath: DOC, dataUrl: null }]);
  });

  it('never takes the write down when the probe throws', async () => {
    const gated = withLayoutGate(tool(wrote(DOC)), WS, () => DOC, {
      probe: async () => {
        throw new Error('no DOM');
      },
      onRender: () => {},
    });
    const out = textOf(await gated.execute('id', { path: DOC, content: 'x' }));
    expect(out).toContain('Wrote');
    expect(out).not.toContain('[Unity layout]');
  });
});

describe('formatting', () => {
  it('states how much was measured, so the count is evidence rather than a claim', () => {
    expect(formatLayoutFindings(DOC, BROKEN)).toContain('14 elements measured');
  });

  it('counts the overflow rather than printing a wall of findings', () => {
    const many = {
      elements: 40,
      styling: null,
      image: null,
      problems: Array.from({ length: 9 }, (_, i) => `code-${i}: bad`),
    };
    const out = formatLayoutFindings(DOC, many);
    expect(out).toContain('code-5');
    expect(out).not.toContain('code-6');
    expect(out).toContain('and 3 more');
  });

  it('names the document in the unmeasured note', () => {
    expect(formatLayoutUnmeasured(DOC)).toContain(DOC);
  });
});
