import { describe, it, expect } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { validateToolArgs } from './validate-args';

const writeSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const readSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

describe('validateToolArgs', () => {
  it('accepts a well-formed call and hands back the arguments', () => {
    const r = validateToolArgs('write', writeSchema, { path: 'A.cs', content: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ path: 'A.cs', content: 'x' });
  });

  // The whole point: the model must be told WHICH field is wrong, because the
  // old behaviour handed it `Cannot read properties of undefined (reading
  // 'split')` from deep inside the write tool and it could not act on that.
  it('names the missing field instead of letting the tool run on undefined', () => {
    const r = validateToolArgs('write', writeSchema, { path: 'A.cs' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('content');
      expect(r.message).toContain('NOT executed');
      expect(r.message).toContain('write');
    }
  });

  it('coerces the stringly-typed numbers models routinely emit', () => {
    const r = validateToolArgs('read', readSchema, { path: 'A.cs', limit: '200' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.limit).toBe(200);
  });

  it('rejects a wrong-typed field rather than coercing nonsense', () => {
    const r = validateToolArgs('write', writeSchema, { path: 'A.cs', content: { a: 1 } });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object argument blob', () => {
    const r = validateToolArgs('write', writeSchema, 'just a string');
    expect(r.ok).toBe(false);
  });

  it('treats absent arguments as a validation failure, not an empty call', () => {
    // This is the `{}` the transport used to fall back to on a parse failure —
    // it must not sail through as a legal zero-argument call.
    const r = validateToolArgs('write', writeSchema, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('path');
  });

  it('does not mutate the caller’s arguments while coercing', () => {
    const args = { path: 'A.cs', limit: '200' };
    validateToolArgs('read', readSchema, args);
    expect(args.limit).toBe('200');
  });

  it('reports unparseable JSON as a JSON problem, quoting what arrived', () => {
    const r = validateToolArgs('write', writeSchema, {}, '{"path":"A.cs","cont');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('not valid JSON');
      expect(r.message).toContain('{"path":"A.cs","cont');
      expect(r.message).toContain('NOT executed');
    }
  });

  it('handles an empty raw blob without pretending it was valid', () => {
    const r = validateToolArgs('write', writeSchema, {}, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('not valid JSON');
  });

  it('caps the echoed blob so a huge malformed argument cannot flood context', () => {
    const raw = 'z'.repeat(5000);
    const r = validateToolArgs('write', writeSchema, {}, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeLessThan(1000);
  });

  it('applies schema defaults so an omitted optional lands as its default', () => {
    const schema = Type.Object({
      path: Type.String(),
      mode: Type.String({ default: 'text' }),
    });
    const r = validateToolArgs('x', schema, { path: 'A.cs' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mode).toBe('text');
  });

  it('tolerates extra properties — this rejects malformed calls, not creative ones', () => {
    const r = validateToolArgs('write', writeSchema, {
      path: 'A.cs',
      content: 'x',
      thinking: 'why not',
    });
    expect(r.ok).toBe(true);
  });
});
