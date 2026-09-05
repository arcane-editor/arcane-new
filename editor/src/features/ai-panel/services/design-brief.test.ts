import { describe, expect, it } from 'bun:test';
import {
  buildDesignBrief,
  formatDesignBrief,
  type DesignBriefDeps,
  type DesignBriefInput,
} from './design-brief';
import type { ElementUsage } from '../../../utils/uxml-usage';

const MARKUP = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="menu-root" class="menu">
    <ui:Button name="play-button" text="Continue" />
  </ui:VisualElement>
</ui:UXML>`;

function usage(over: Partial<ElementUsage> = {}): ElementUsage {
  return {
    elementName: 'play-button',
    kind: 'clicked',
    event: 'clicked',
    handler: 'StartGame',
    handlerLine: 61,
    filePath: 'Assets/Scripts/MainMenu.cs',
    line: 42,
    column: 9,
    snippet: 'root.Q<Button>("play-button").clicked += StartGame;',
    ...over,
  };
}

function input(over: Partial<DesignBriefInput> = {}): DesignBriefInput {
  return {
    documentPath: 'Assets/UI/MainMenu.uxml',
    markup: MARKUP,
    sheets: [{ path: 'Assets/UI/Theme.uss', source: '.menu { background-color: black; }' }],
    usages: [usage()],
    usagesLoaded: true,
    coverageNote: null,
    ...over,
  };
}

describe('formatDesignBrief', () => {
  it('puts the markup and the stylesheet source in front of the model', () => {
    const text = formatDesignBrief(input());
    expect(text).toContain('play-button');
    expect(text).toContain('background-color: black');
    expect(text).toContain('Assets/UI/Theme.uss');
  });

  it('renders the usage map with the handler and the call site', () => {
    const text = formatDesignBrief(input());
    expect(text).toContain('#play-button');
    expect(text).toContain('on click → StartGame()');
    expect(text).toContain('Assets/Scripts/MainMenu.cs:42');
  });

  it('tells the model the list is complete, which is the whole point', () => {
    const text = formatDesignBrief(input());
    expect(text).toContain('there is no more');
    expect(text).toContain('Do not');
  });

  it('says "nothing reaches this screen" without inviting a search', () => {
    const text = formatDesignBrief(input({ usages: [] }));
    expect(text).toContain('No C# in this project reaches');
    expect(text).toContain('you do not need to read any');
    expect(text).not.toContain('there is no more');
  });

  it('distinguishes an unfinished walk from a genuinely empty one', () => {
    // The one wrong conclusion this section exists to prevent: reading
    // "no usages" off a scan that never ran.
    const text = formatDesignBrief(input({ usages: [], usagesLoaded: false }));
    expect(text).toContain('UNKNOWN');
    expect(text).not.toContain('cannot break code');
    // And no completeness claim, because nothing was established.
    expect(text).not.toContain('there is no more');
  });

  it('names the no-stylesheet case as the reason a class can style nothing', () => {
    const text = formatDesignBrief(input({ sheets: [] }));
    expect(text).toContain('Unity default styling');
    expect(text).toContain('<Style src>');
  });

  it('announces a truncated stylesheet instead of silently cutting it', () => {
    const huge = `.a { color: red; }\n${'/* filler */\n'.repeat(2000)}`;
    const text = formatDesignBrief(input({ sheets: [{ path: 'Big.uss', source: huge }] }));
    expect(text).toContain('truncated at');
    expect(text).toContain('use `read` for the rest');
  });

  it('includes the coverage note only when there is something to say', () => {
    expect(formatDesignBrief(input())).not.toContain('Styling coverage');
    expect(formatDesignBrief(input({ coverageNote: '9 of 14 matched no rule.' }))).toContain(
      'Styling coverage',
    );
  });
});

describe('buildDesignBrief', () => {
  const WS = '/ws';
  const DOC = '/ws/Assets/UI/MainMenu.uxml';

  function deps(over: Partial<DesignBriefDeps> = {}): DesignBriefDeps {
    return {
      readFile: async () => MARKUP,
      guidMap: async () => ({}),
      styles: async () => ({
        sheets: [{ path: 'Assets/UI/Theme.uss', source: '.menu { color: white; }' }],
        coverageNote: null,
      }),
      usages: async () => [usage()],
      ...over,
    };
  }

  it('makes every path workspace-relative, matching the tree the user sees', async () => {
    const text = await buildDesignBrief(WS, DOC, deps());
    expect(text).toContain('Assets/UI/MainMenu.uxml');
    expect(text).not.toContain('/ws/Assets');
  });

  it('asks about every named element in one call, not one call per name', async () => {
    let calls = 0;
    let asked: string[] = [];
    await buildDesignBrief(
      WS,
      DOC,
      deps({
        usages: async (_ws, names) => {
          calls++;
          asked = names;
          return [];
        },
      }),
    );
    expect(calls).toBe(1);
    expect(asked.sort()).toEqual(['menu-root', 'play-button']);
  });

  it('degrades to "read it before changing it" when the document is unreadable', async () => {
    const text = await buildDesignBrief(WS, DOC, deps({ readFile: async () => null }));
    expect(text).toContain('could not be read');
  });

  it('reports the C# half as unknown when the scan fails, never as empty', async () => {
    const text = await buildDesignBrief(
      WS,
      DOC,
      deps({
        usages: async () => {
          throw new Error('no index');
        },
      }),
    );
    expect(text).toContain('UNKNOWN');
  });

  it('still produces a brief when the stylesheets cannot be resolved', async () => {
    const text = await buildDesignBrief(
      WS,
      DOC,
      deps({
        styles: async () => {
          throw new Error('no guid map');
        },
      }),
    );
    expect(text).toContain('play-button');
    expect(text).toContain('Unity default styling');
  });
});
