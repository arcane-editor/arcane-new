import { describe, it, expect } from 'bun:test';
import { computeUnityDecorations } from './csharp-decorations';

// Every Unity name used here is present in UNITY_API_NAMES with kind 'type'.
// `CharacterController` deliberately is NOT used — it is a real Unity type
// that the list happens to omit, so asserting either way about it would pin
// down a gap in the data rather than the behaviour of this function.
const SOURCE = `using UnityEngine;

[RequireComponent(typeof(Rigidbody))]
public class PlayerController : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float moveSpeed = 6f;

    private Rigidbody _body;

    private void Awake()
    {
        _body = GetComponent<Rigidbody>();
    }

    private void Recalculate()
    {
    }
}
`;

const LINES = SOURCE.split('\n');
const textOf = (d: { line: number; startColumn: number; endColumn: number }) =>
  LINES[d.line - 1].slice(d.startColumn - 1, d.endColumn - 1);

describe('computeUnityDecorations', () => {
  const found = computeUnityDecorations(SOURCE);
  const kinds = (k: string) => found.filter((d) => d.kind === k);

  it('marks a method the engine calls', () => {
    const lifecycle = kinds('lifecycle');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].line).toBe(11);
    expect(textOf(lifecycle[0])).toBe('Awake');
  });

  it('does not mark an ordinary method', () => {
    expect(kinds('lifecycle').some((d) => d.line === 16)).toBe(false);
  });

  it('marks engine types but not user types', () => {
    const names = kinds('engine-type').map(textOf);
    expect(names).toContain('MonoBehaviour');
    expect(names).toContain('Rigidbody');
    expect(names).not.toContain('PlayerController');
  });

  // UNITY_API_NAMES carries methods and properties too, and C# method names
  // are capitalised, so an unfiltered lookup would paint `GetComponent` as a
  // type.
  it('does not mark an engine method as a type', () => {
    const names = kinds('engine-type').map(textOf);
    expect(names).not.toContain('GetComponent');
  });

  it('marks Inspector-facing attributes', () => {
    const lines = kinds('inspector-attribute').map((d) => d.line).sort((a, b) => a - b);
    expect(lines).toEqual([6, 7]);
  });

  it('attaches lifecycle hover text describing when the engine calls it', () => {
    expect(kinds('lifecycle')[0].hover).toContain('Awake');
  });

  it('returns nothing for a file with no Unity content', () => {
    expect(computeUnityDecorations('class Plain { void Go() {} }')).toEqual([]);
  });
});
