import { describe, expect, it } from 'bun:test';
import type { AnalyzerRule, Finding, RuleContext } from '../services/analyzer-engine';
import { scanCSharp } from '../services/csharp-scan';
import { runRules } from '../services/rule-runner';
import { allocInUpdateRule } from './alloc-in-update';
import { cameraMainRule } from './camera-main';
import { destroyThisRule } from './destroy-this';
import { editorApiInRuntimeRule } from './editor-api-in-runtime';
import { emptyMessagesRule } from './empty-messages';
import { getComponentInUpdateRule } from './getcomponent-in-update';
import { nearMissMessagesRule } from './near-miss-messages';
import { nonSerializableTypesRule } from './non-serializable-types';
import { nullPropagationUnityObjectRule } from './null-propagation-unity-object';
import { waitForSecondsInLoopRule } from './waitforseconds-in-loop';
import { ALL_RULES } from './index';

// Thirteen of these rules had no test at all. They are regular expressions
// pointed at half-typed C#, they run on every keystroke, and a false positive
// is worse than a missing check — it teaches people to ignore the squiggles.
// The hot-path family in particular is the reason this engine still exists:
// Microsoft.Unity.Analyzers reports what is semantically wrong for Unity, and
// has nothing at all for "this is ruinous to call sixty times a second".

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    model: null,
    monaco: null,
    filePath: '/proj/Assets/Scripts/Player.cs',
    unityVersion: '6000.0.24f1',
    ...overrides,
  };
}

function run(rule: AnalyzerRule, code: string, overrides: Partial<RuleContext> = {}): Finding[] {
  return rule.run(scanCSharp(code), ctx(overrides));
}

/**
 * The slice of `editor.ITextModel` the fix builders touch.
 *
 * `buildEdit` needs a model to key its workspace edit and to offer a fix at
 * all — without one the builders return undefined, which is why the hoist fix
 * went untested while its generated text was wrong.
 */
function fakeModel(text: string) {
  const lines = text.split('\n');
  return {
    uri: { toString: () => 'file:///probe.cs' },
    getValue: () => text,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  } as unknown as NonNullable<RuleContext['model']>;
}

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code ?? '');
}

/** A MonoBehaviour with `body` as the contents of the named method. */
function behaviour(method: string, body: string, extra = ''): string {
  return [
    'using UnityEngine;',
    '',
    'public class Player : MonoBehaviour',
    '{',
    extra,
    `    private void ${method}()`,
    '    {',
    body,
    '    }',
    '}',
    '',
  ].join('\n');
}

describe('hot-path lookups (UNITY0201)', () => {
  it('flags GetComponent called every frame', () => {
    const found = run(getComponentInUpdateRule, behaviour('Update', '        var r = GetComponent<Rigidbody>();'));
    expect(codes(found)).toContain('UNITY0201');
  });

  it('flags the whole component-lookup family', () => {
    for (const call of [
      'GetComponentInChildren<Collider>()',
      'GetComponentsInParent<Renderer>()',
      'FindObjectOfType<Camera>()',
      'FindFirstObjectByType<Camera>()',
      'FindAnyObjectByType<Camera>()',
    ]) {
      const found = run(getComponentInUpdateRule, behaviour('Update', `        var x = ${call};`));
      expect(codes(found)).toContain('UNITY0201');
    }
  });

  it('flags scene-wide searches and hierarchy walks', () => {
    for (const call of [
      'GameObject.Find("Player")',
      'GameObject.FindWithTag("Enemy")',
      'GameObject.FindGameObjectsWithTag("Enemy")',
      'transform.Find("Hand")',
      'Resources.Load<Texture>("icon")',
    ]) {
      const found = run(getComponentInUpdateRule, behaviour('Update', `        var x = ${call};`));
      expect(codes(found)).toContain('UNITY0201');
    }
  });

  it('flags reflective Unity messaging as UNITY0211', () => {
    // UNT0016 covers Invoke and StartCoroutine; nothing upstream covers these.
    for (const call of [
      'SendMessage("TakeDamage")',
      'gameObject.SendMessage("TakeDamage")',
      'other.gameObject.BroadcastMessage("Reset")',
      'transform.SendMessageUpwards("Hit")',
    ]) {
      const found = run(getComponentInUpdateRule, behaviour('Update', `        ${call};`));
      expect(codes(found), call).toContain('UNITY0211');
    }
  });

  it('does not flag someone else\'s method that happens to be called SendMessage', () => {
    // A chat wrapper, a socket, a message bus. `SendMessage` is an ordinary
    // name, and a per-frame performance warning on correct code is how an
    // analyzer teaches people to ignore it.
    for (const line of [
      '        socket.SendMessage(buffer);',
      '        chat.SendMessage("hello");',
      '        _bus.BroadcastMessage(payload);',
    ]) {
      const found = run(getComponentInUpdateRule, behaviour('Update', line));
      expect(codes(found), line).not.toContain('UNITY0211');
    }
  });

  it('flags per-frame logging as a hint, not a warning', () => {
    // A habit worth breaking, not a defect — and legitimate while debugging.
    const found = run(getComponentInUpdateRule, behaviour('Update', '        Debug.Log("tick");'));
    const hint = found.find((f) => f.code === 'UNITY0212');
    expect(hint?.severity).toBe('hint');
  });

  it('covers the messages that are hot but not obviously so', () => {
    // OnTriggerStay runs per contact per physics step; OnAudioFilterRead runs
    // on the audio thread at buffer rate.
    for (const message of ['LateUpdate', 'FixedUpdate', 'OnGUI', 'OnTriggerStay', 'OnAudioFilterRead']) {
      const found = run(
        getComponentInUpdateRule,
        behaviour(message, '        var r = GetComponent<Rigidbody>();'),
      );
      expect(codes(found)).toContain('UNITY0201');
    }
  });

  it('says nothing about a lookup done once', () => {
    for (const message of ['Awake', 'Start', 'OnEnable', 'OnDestroy']) {
      const found = run(
        getComponentInUpdateRule,
        behaviour(message, '        var r = GetComponent<Rigidbody>();'),
      );
      expect(found).toEqual([]);
    }
  });

  it('says nothing about a plain class that happens to have Update', () => {
    // Unity only calls these on a MonoBehaviour; on anything else `Update` is
    // an ordinary method that runs when someone calls it.
    const found = run(
      getComponentInUpdateRule,
      [
        'public class NotABehaviour',
        '{',
        '    private void Update()',
        '    {',
        '        var r = GetComponent<Rigidbody>();',
        '    }',
        '}',
      ].join('\n'),
    );
    expect(found).toEqual([]);
  });

  it('offers a hoist fix that produces the code it describes', () => {
    // The fix's TEXT is what matters — it is applied verbatim. Asserting only
    // that a fix exists would pass for a fix that generates wrong code.
    const src = behaviour('Update', '        var r = GetComponent<Rigidbody>();');
    const found = run(getComponentInUpdateRule, src, { model: fakeModel(src) });
    const edits = found[0]?.fixes?.[0]?.edit?.changes?.['file:///probe.cs'] ?? [];
    const text = edits.map((e) => e.newText).join('\n');
    expect(text).toContain('private Rigidbody _rigidbody;');
    expect(text).toContain('_rigidbody = GetComponent<Rigidbody>();');
    expect(text).toContain('private void Awake()');
  });

  it('does not offer the hoist fix for a call on another object', () => {
    // `other.GetComponent<Rigidbody>()` is still worth warning about, but the
    // generated `Awake` would cache THIS object's Rigidbody — code that
    // compiles and refers to the wrong thing, which is worse than no fix.
    const src = behaviour('Update', '        var r = other.GetComponent<Rigidbody>();');
    const found = run(getComponentInUpdateRule, src, { model: fakeModel(src) });
    expect(codes(found)).toContain('UNITY0201');
    expect(found[0]?.fixes ?? []).toEqual([]);
  });
});

describe('Camera.main (UNITY0202)', () => {
  const body = '        var c = Camera.main;';

  it('flags it on a Unity older than 2020.2, where it was not cached', () => {
    expect(codes(run(cameraMainRule, behaviour('Update', body), { unityVersion: '2019.4.0f1' })))
      .toContain('UNITY0202');
  });

  it('says nothing on 2020.2 and later, where Unity caches it', () => {
    for (const version of ['2020.2.0f1', '2022.3.10f1', '6000.0.24f1']) {
      expect(run(cameraMainRule, behaviour('Update', body), { unityVersion: version })).toEqual([]);
    }
  });

  it('stays silent when the Unity version is unknown', () => {
    // Guessing here means warning about correct code on every project whose
    // version could not be read.
    expect(run(cameraMainRule, behaviour('Update', body), { unityVersion: null })).toEqual([]);
  });
});

describe('allocation in a hot path (UNITY0205-0207)', () => {
  it('flags LINQ only when the file actually imports it', () => {
    const withLinq = [
      'using UnityEngine;',
      'using System.Linq;',
      'public class Player : MonoBehaviour',
      '{',
      '    private void Update()',
      '    {',
      '        var first = items.Where(x => x != null).ToList();',
      '    }',
      '}',
    ].join('\n');
    expect(codes(run(allocInUpdateRule, withLinq))).toContain('UNITY0205');
  });

  it('flags a new reference type but not a struct', () => {
    // `new Vector3(...)` allocates nothing — it is a struct.
    expect(codes(run(allocInUpdateRule, behaviour('Update', '        var l = new List<int>();'))))
      .toContain('UNITY0206');
    expect(run(allocInUpdateRule, behaviour('Update', '        var v = new Vector3(1, 2, 3);')))
      .toEqual([]);
  });

  it('does not read string concatenation out of a comment', () => {
    // It used to scan the raw text, so a comment mentioning the pattern the
    // rule warns about triggered the rule.
    const src = behaviour(
      'Update',
      '        for (int i = 0; i < 3; i++) { /* replace s + "suffix" here */ }',
    );
    expect(codes(run(allocInUpdateRule, src))).not.toContain('UNITY0207');
  });

  it('still flags real concatenation in a loop', () => {
    const src = behaviour('Update', '        for (int i = 0; i < 3; i++) { s += "x"; }');
    expect(codes(run(allocInUpdateRule, src))).toContain('UNITY0207');
  });

  it('no longer flags foreach', () => {
    // It used to. List, arrays and Dictionary all return struct enumerators,
    // so the rule fired on correct code — which is how a performance analyzer
    // teaches people to ignore it.
    const found = run(allocInUpdateRule, behaviour('Update', '        foreach (var x in items) { }'));
    expect(codes(found)).not.toContain('UNITY0208');
  });
});

describe('empty Unity messages (UNITY0209)', () => {
  it('flags a message Unity still calls every frame for nothing', () => {
    expect(codes(run(emptyMessagesRule, behaviour('LateUpdate', '')))).toContain('UNITY0209');
  });

  it('says nothing about a message that does something', () => {
    expect(run(emptyMessagesRule, behaviour('Update', '        Move();'))).toEqual([]);
  });

  it('defers to UNT0001, which knows a comment-only body from an empty one', () => {
    expect(emptyMessagesRule.supersededBy).toContain('UNT0001');
  });
});

describe('WaitForSeconds allocated in a loop (UNITY0210)', () => {
  const coroutine = [
    'using UnityEngine;',
    'using System.Collections;',
    'public class Player : MonoBehaviour',
    '{',
    '    private IEnumerator Tick()',
    '    {',
    '        while (true)',
    '        {',
    '            yield return new WaitForSeconds(1f);',
    '        }',
    '    }',
    '}',
  ].join('\n');

  it('flags a fresh instance allocated on every iteration', () => {
    expect(codes(run(waitForSecondsInLoopRule, coroutine))).toContain('UNITY0210');
  });

  it('says nothing when the wait is cached outside the loop', () => {
    const cached = coroutine
      .replace('        while (true)', '        var wait = new WaitForSeconds(1f);\n        while (true)')
      .replace('yield return new WaitForSeconds(1f);', 'yield return wait;');
    expect(run(waitForSecondsInLoopRule, cached)).toEqual([]);
  });
});

describe('Destroy(this) (UNITY0310)', () => {
  it('flags destroying the component when the object was meant', () => {
    expect(codes(run(destroyThisRule, behaviour('Start', '        Destroy(this);'))))
      .toContain('UNITY0310');
  });

  it('says nothing about Destroy(gameObject)', () => {
    expect(run(destroyThisRule, behaviour('Start', '        Destroy(gameObject);'))).toEqual([]);
  });
});

describe('UnityEditor APIs in runtime code (UNITY0311)', () => {
  const runtime = [
    'using UnityEngine;',
    'using UnityEditor;',
    'public class Player : MonoBehaviour',
    '{',
    '}',
  ].join('\n');

  it('flags a using that will not exist in a player build', () => {
    const found = run(runtime === '' ? editorApiInRuntimeRule : editorApiInRuntimeRule, runtime, {
      owningAssembly: () => 'Assembly-CSharp',
      isEditorOnlyAssembly: () => false,
    });
    expect(codes(found)).toContain('UNITY0311');
    expect(found[0]?.severity).toBe('error');
  });

  it('says nothing in an Editor folder', () => {
    expect(
      run(editorApiInRuntimeRule, runtime, {
        filePath: '/proj/Assets/Scripts/Editor/Tool.cs',
        owningAssembly: () => 'Assembly-CSharp',
        isEditorOnlyAssembly: () => false,
      }),
    ).toEqual([]);
  });

  it('says nothing in an editor-only assembly', () => {
    expect(
      run(editorApiInRuntimeRule, runtime, {
        owningAssembly: () => 'MyTools.Editor',
        isEditorOnlyAssembly: () => true,
      }),
    ).toEqual([]);
  });

  it('stays silent while the owning assembly is still unknown', () => {
    // Reporting a build-breaking error on a guess is worse than reporting
    // nothing; the engine re-runs the rule once the lookup lands.
    let refreshed = false;
    expect(
      run(editorApiInRuntimeRule, runtime, {
        owningAssembly: () => undefined,
        requestRefresh: () => {
          refreshed = true;
        },
      }),
    ).toEqual([]);
    expect(refreshed).toBe(true);
  });
});

describe('near-miss Unity messages (UNITY0001-0003)', () => {
  it('flags a message whose name has the wrong case', () => {
    // `void update()` is never called by Unity, and nothing else complains.
    const found = run(nearMissMessagesRule, behaviour('update', '        Move();'));
    expect(codes(found)).toContain('UNITY0001');
  });

  it('says nothing about a correctly spelled message', () => {
    expect(run(nearMissMessagesRule, behaviour('Update', '        Move();'))).toEqual([]);
  });
});

describe('non-serializable serialized fields (UNITY0101-0103)', () => {
  it('flags a type the inspector cannot serialize', () => {
    const src = [
      'using UnityEngine;',
      'using System.Collections.Generic;',
      'public class Player : MonoBehaviour',
      '{',
      '    [SerializeField] private Dictionary<string, int> lookup;',
      '}',
    ].join('\n');
    expect(codes(run(nonSerializableTypesRule, src)).some((c) => c.startsWith('UNITY01'))).toBe(true);
  });

  it('says nothing about a type it can', () => {
    const src = [
      'using UnityEngine;',
      'using System.Collections.Generic;',
      'public class Player : MonoBehaviour',
      '{',
      '    [SerializeField] private List<int> values;',
      '    [SerializeField] private Vector3 offset;',
      '}',
    ].join('\n');
    expect(run(nonSerializableTypesRule, src)).toEqual([]);
  });
});

describe('null propagation on a UnityEngine.Object (UNITY0312)', () => {
  it('flags `?.` on a type whose == is overloaded', () => {
    const src = [
      'using UnityEngine;',
      'public class Player : MonoBehaviour',
      '{',
      '    private Rigidbody body;',
      '    private void Update()',
      '    {',
      '        body?.Sleep();',
      '    }',
      '}',
    ].join('\n');
    expect(codes(run(nullPropagationUnityObjectRule, src))).toContain('UNITY0312');
  });

  it('says nothing about an explicit null comparison', () => {
    const src = [
      'using UnityEngine;',
      'public class Player : MonoBehaviour',
      '{',
      '    private Rigidbody body;',
      '    private void Update()',
      '    {',
      '        if (body != null) { body.Sleep(); }',
      '    }',
      '}',
    ].join('\n');
    expect(run(nullPropagationUnityObjectRule, src)).toEqual([]);
  });
});

describe('every rule, against input that is not valid C#', () => {
  // These run on every keystroke, so they see half-typed code constantly. A
  // rule that throws takes the whole publish down; a rule that reports
  // nonsense on an unfinished line is worse than one that waits.
  const HOSTILE = [
    '',
    '   ',
    '// just a comment',
    'using UnityEngine;',
    'public class',
    'public class Player : MonoBehaviour {',
    'public class Player : MonoBehaviour { void Update() { GetComponent<',
    '"unterminated string',
    '/* unterminated comment',
    '}}}}}}',
  ];

  it('never throws', () => {
    for (const source of HOSTILE) {
      for (const rule of ALL_RULES) {
        expect(() => rule.run(scanCSharp(source), ctx())).not.toThrow();
      }
    }
  });

  it('reports nothing on an empty or comment-only file', () => {
    for (const source of ['', '   ', '// just a comment']) {
      expect(runRules(ALL_RULES, scanCSharp(source), ctx())).toEqual([]);
    }
  });
});

describe('deferring to the Roslyn analyzers', () => {
  const src = behaviour('LateUpdate', '');

  it('reports the superseded finding when Roslyn is not running', () => {
    const found = runRules([emptyMessagesRule], scanCSharp(src), ctx({ roslynAnalyzersActive: false }));
    expect(codes(found)).toContain('UNITY0209');
  });

  it('stands down when Roslyn is running', () => {
    // UNT0001 says the same thing with a real parser.
    expect(runRules([emptyMessagesRule], scanCSharp(src), ctx({ roslynAnalyzersActive: true })))
      .toEqual([]);
  });

  it('keeps the hot-path rules running either way', () => {
    // Nothing upstream covers these, so deferring would lose them entirely.
    const hot = behaviour('Update', '        var r = GetComponent<Rigidbody>();');
    for (const active of [true, false]) {
      const found = runRules(
        [getComponentInUpdateRule],
        scanCSharp(hot),
        ctx({ roslynAnalyzersActive: active }),
      );
      expect(codes(found)).toContain('UNITY0201');
    }
  });
});
