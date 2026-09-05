import { describe, it, expect } from 'bun:test';
import { buildUiDesignPrompt } from './ui-design';
import { DESIGN_RULES } from './ui-design-facts';
import { UNITY_CONTEXT } from './unity-context';
import { CSS_ONLY_PROPERTIES } from '../../../../utils/uss-properties';
import { UNSUPPORTED_UNITS } from '../unity-tools/asset-checks';

const PROMPT = buildUiDesignPrompt('/proj', {
  documentPath: 'Assets/UI/MainMenu.uxml',
  documentName: 'MainMenu.uxml',
});

describe('buildUiDesignPrompt', () => {
  it('names the one document the session is scoped to', () => {
    expect(PROMPT).toContain('Assets/UI/MainMenu.uxml');
    expect(PROMPT).toContain('MainMenu.uxml');
  });

  it('states the scope in both directions — new stylesheets yes, new documents no', () => {
    expect(PROMPT).toContain('New `.uss` files');
    expect(PROMPT).toContain('do **not** create new `.uxml` documents');
    expect(PROMPT).toContain('AI panel');
  });

  it('carries the mechanical rules verbatim rather than restating them', () => {
    // A scaffold recipe and the frozen prompt wording the same rule differently
    // is how the two drift — `ui-design-facts.ts` says so where DESIGN_RULES is
    // defined, and this is the other half of that promise.
    for (const rule of DESIGN_RULES) expect(PROMPT).toContain(rule);
  });

  it('requires the layout pass, not just the write', () => {
    expect(PROMPT).toContain('unity_ui_write');
    expect(PROMPT).toContain('unity_ui_layout');
    expect(PROMPT).toContain('This is not optional');
  });

  it('asks for the direction line the dock renders', () => {
    // `design-rows.ts` promotes the opening line of a turn on the strength of
    // this instruction; if it goes, the log's direction row becomes a guess.
    expect(PROMPT).toContain('one line naming the direction');
  });

  it('names the generic defaults instead of only asking for good taste', () => {
    expect(PROMPT).toContain('rounded buttons');
    expect(PROMPT).toContain('None of them is a choice');
  });

  it('does not invent a font mechanism USS lacks', () => {
    expect(PROMPT).toContain('-unity-font-definition');
    expect(PROMPT).toContain('USS has no `font-family`');
  });
});

describe('buildUiDesignPrompt — the loop that produces a styled screen', () => {
  it('makes the stylesheet a step, not a permission', () => {
    // The original loop was read -> direction -> write -> layout -> fix ->
    // keep C# in step. `.uss` appeared only under "what you may change", so a
    // model following it literally never authored a rule. That is the reported
    // "hardly any css applied".
    expect(PROMPT).toContain('**Write the stylesheet first**');
  });

  it('orders the stylesheet before the markup, which is the order the write tool needs', () => {
    // A `<Style src>` pointing at a file not yet on disk is a blocking refusal.
    expect(PROMPT.indexOf('**Write the stylesheet first**')).toBeLessThan(
      PROMPT.indexOf('**Write the markup**'),
    );
  });

  it('says an unstyled screen is not finished, however cleanly it lays out', () => {
    expect(PROMPT).toContain('matched no rule is not finished');
  });

  it('names unity_ui_scaffold, the only tool that returns a complete stylesheet', () => {
    // It ships states-and-all `.uss` for all five templates and was never
    // mentioned here, so it was effectively unreachable from design mode.
    expect(PROMPT).toContain('unity_ui_scaffold');
    // And redirects its recipe at the session document, since the path it
    // suggests would be refused by `withDesignScope`.
    expect(PROMPT).toContain('rather than the new path it suggests');
  });
});

describe('buildUiDesignPrompt — C# is conditional, not a standing obligation', () => {
  it('puts C# behind an explicit condition and points at the brief', () => {
    expect(PROMPT).toContain('only if a name moved');
    expect(PROMPT).toContain('do not go looking');
  });

  it('does not carry the Unity C# programming crib', () => {
    // `UNITY_CONTEXT` was appended whole: assemblies, MonoBehaviour lifecycle,
    // comment policy, an API crib, the Test Framework — roughly 60% of this
    // prompt by volume, none of it about styling.
    expect(PROMPT).not.toContain(UNITY_CONTEXT);
    expect(PROMPT).not.toContain('FixedUpdate');
    expect(PROMPT).not.toContain('get_unity_script_map');
    expect(PROMPT).not.toContain('[UnityTest]');
  });

  it('still carries the UI Toolkit context it replaced it with', () => {
    expect(PROMPT).toContain('## Unity UI Toolkit context');
    expect(PROMPT).toContain('confined to the `Assets/` folder');
  });

  it('tells the model a brief arrives with every message', () => {
    expect(PROMPT).toContain('Every message you get carries a brief');
  });
});

describe('buildUiDesignPrompt — the refused-USS list is generated, not written', () => {
  it('lists every CSS-only property the write tool refuses, with its remedy', () => {
    // Generated from `CSS_ONLY_PROPERTIES` itself: a prompt that named a
    // different set from the validator is how a model learns to treat a
    // refusal as noise.
    for (const [name, remedy] of CSS_ONLY_PROPERTIES) {
      expect(PROMPT).toContain(`\`${name}\``);
      expect(PROMPT).toContain(remedy);
    }
  });

  it('lists every unit the write tool refuses', () => {
    for (const unit of UNSUPPORTED_UNITS) expect(PROMPT).toContain(`\`${unit}\``);
  });

  it('says the refusal is whole-file and lists everything at once', () => {
    // The economics that were pushing the model away from writing stylesheets:
    // one `gap` in a 200-line draft costs a full re-emission.
    expect(PROMPT).toContain('REFUSED WHOLE');
    expect(PROMPT).toContain('lists every problem at once');
  });
});
