import { describe, it, expect } from 'bun:test';
import { designWriteRefusal } from './design-scope';

const DOC = 'Assets/UI/MainMenu.uxml';

describe('designWriteRefusal', () => {
  it('allows the document the session is scoped to', () => {
    expect(designWriteRefusal(DOC, DOC)).toBeNull();
  });

  it('allows a stylesheet, new or existing — a theme has nowhere else to go', () => {
    expect(designWriteRefusal('Assets/UI/MainMenu.uss', DOC)).toBeNull();
    expect(designWriteRefusal('Assets/UI/Theme.uss', DOC)).toBeNull();
  });

  it('refuses another .uxml, and says where a new screen comes from instead', () => {
    const refusal = designWriteRefusal('Assets/UI/Settings.uxml', DOC);
    expect(refusal).toContain('Assets/UI/Settings.uxml');
    expect(refusal).toContain('AI panel');
  });

  it('ignores case and a leading ./ when matching the target', () => {
    expect(designWriteRefusal('./assets/ui/mainmenu.uxml', DOC)).toBeNull();
  });

  it('refuses nothing at all when no target is set — this is not agent mode', () => {
    expect(designWriteRefusal('Assets/UI/Settings.uxml', null)).toBeNull();
  });
});
