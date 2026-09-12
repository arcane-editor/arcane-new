import { describe, it, expect } from 'bun:test';
import { queryContextAt } from './uitoolkit-query-context';

/** `at` marks the caret with `|`, which is stripped before parsing. */
function at(source: string) {
  const offset = source.indexOf('|');
  if (offset === -1) throw new Error('no caret in fixture');
  return queryContextAt(source.replace('|', ''), offset);
}

describe('element-name slot', () => {
  it('recognises a generic query mid-type', () => {
    const c = at('root.Q<Button>("play-butt|');
    expect(c).not.toBe(null);
    expect(c!.slot).toBe('name');
    expect(c!.typeArg).toBe('Button');
    expect(c!.value).toBe('play-butt');
  });

  it('recognises a non-generic query', () => {
    const c = at('var e = root.Q("wordm|");');
    expect(c!.slot).toBe('name');
    expect(c!.typeArg).toBe(null);
  });

  it('recognises Query as well as Q', () => {
    expect(at('root.Query<Label>("ti|")')!.slot).toBe('name');
  });

  it('reads a named name: argument', () => {
    const c = at('root.Q<Button>(name: "play|")');
    expect(c!.slot).toBe('name');
    expect(c!.typeArg).toBe('Button');
  });

  it('strips the namespace off the generic', () => {
    expect(at('root.Q<UnityEngine.UIElements.Button>("x|")')!.typeArg).toBe('Button');
  });

  it('spans the literal contents, excluding the quotes', () => {
    const src = 'root.Q<Button>("play-button");';
    const c = queryContextAt(src, src.indexOf('play') + 2)!;
    expect(src.slice(c.start, c.end)).toBe('play-button');
  });

  it('works with the caret on the closing quote, where typing leaves it', () => {
    const src = 'root.Q<Button>("play-button");';
    expect(queryContextAt(src, src.indexOf('"', 15) + 12)!.slot).toBe('name');
  });
});

describe('class slot', () => {
  it('reads the second positional argument as a class', () => {
    // `Q(name, className)` is positional -- treating this as a name is the
    // single easiest way to get the whole feature wrong.
    const c = at('root.Q<Button>("play-button", "prim|")');
    expect(c!.slot).toBe('className');
  });

  it('reads a named className: argument', () => {
    expect(at('root.Q<Button>(className: "prim|")')!.slot).toBe('className');
  });

  it('reads a class after a null name', () => {
    expect(at('root.Q(null, "prim|")')!.slot).toBe('className');
  });

  it('reads the class-list calls', () => {
    for (const call of [
      'el.AddToClassList("hid|")',
      'el.RemoveFromClassList("hid|")',
      'el.ToggleInClassList("hid|")',
      'el.ClassListContains("hid|")',
    ]) {
      expect(at(call)!.slot).toBe('className');
    }
  });

  it('reads EnableInClassList, whose class is still the first argument', () => {
    expect(at('el.EnableInClassList("hid|", true)')!.slot).toBe('className');
  });
});

describe('when it must say nothing', () => {
  it('an unrelated string literal', () => {
    expect(at('var label = "Jump the ga|p";')).toBe(null);
  });

  it('a caret outside any literal', () => {
    expect(at('root.Q<Button>(|"play-button");')).toBe(null);
  });

  it('a query inside a line comment', () => {
    // Offering completions inside commented-out code is noise.
    expect(at('// root.Q<Button>("pla|")')).toBe(null);
  });

  it('a string that merely follows a comment marker inside another string', () => {
    // The `//` here is inside a URL literal, so the second literal is real code.
    const c = at('Log("http://x"); root.Q<Button>("pla|")');
    expect(c).not.toBe(null);
    expect(c!.slot).toBe('name');
  });

  it('a third positional argument, which we cannot help with', () => {
    expect(at('root.Q<Button>("a", "b", "c|")')).toBe(null);
  });

  it('a method that merely starts with Q', () => {
    expect(at('thing.Quantise("val|")')).toBe(null);
  });

  it('an empty document', () => {
    expect(queryContextAt('', 0)).toBe(null);
  });
});

describe('multi-line source', () => {
  const SRC = [
    'void OnEnable() {',
    '    var root = doc.rootVisualElement;',
    '    root.Q<Button>("play-button").clicked += Go;',
    '}',
  ].join('\n');

  it('finds the literal on the right line and reports absolute offsets', () => {
    const c = queryContextAt(SRC, SRC.indexOf('play-button') + 3)!;
    expect(c.slot).toBe('name');
    expect(c.typeArg).toBe('Button');
    expect(SRC.slice(c.start, c.end)).toBe('play-button');
  });

  it('says nothing on a line with no query', () => {
    expect(queryContextAt(SRC, SRC.indexOf('rootVisualElement'))).toBe(null);
  });
});
