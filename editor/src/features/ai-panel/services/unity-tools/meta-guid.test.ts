// The properties worth pinning: a GUID is always 32 lowercase hex chars, never
// one of Unity's reserved/all-zero values, collision retry actually retries
// (rather than looping forever or giving up too early), an existing `.meta`'s
// non-guid content survives untouched, and the `<Style src>` URI escapes the
// characters that are structurally significant inside an XML attribute.

import { describe, it, expect } from 'bun:test';
import {
  newUnityGuid,
  allocateGuid,
  buildMetaText,
  minimalMetaText,
  extractGuidFromMeta,
  styleSrcFor,
  relativeStyleSrc,
  type MetaKind,
  type RandomBytes,
} from './meta-guid';

const ALL_ZERO = '0'.repeat(32);
const RESERVED_E = '0000000000000000e000000000000000';
const RESERVED_F = '0000000000000000f000000000000000';
const VALID1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A `random` that hands out one fixed 16-byte value per call, decoded from a 32-hex-char guid string. */
function queueRandom(hexGuids: readonly string[]): RandomBytes {
  const queue = [...hexGuids];
  return () => {
    const hex = queue.shift();
    if (!hex) throw new Error('queueRandom: exhausted');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  };
}

describe('newUnityGuid', () => {
  it('is 32 lowercase hex characters', () => {
    const random = queueRandom([VALID1]);
    expect(newUnityGuid(random)).toBe(VALID1);
  });

  it('zero-pads bytes below 0x10 so the length never varies', () => {
    const random: RandomBytes = () => new Uint8Array(16); // every byte 0x00
    expect(newUnityGuid(random)).toBe(ALL_ZERO);
  });
});

describe('allocateGuid', () => {
  it('returns the first candidate when nothing collides', () => {
    const issued = new Set<string>();
    const guid = allocateGuid({ taken: () => false, issued, random: queueRandom([VALID1]) });
    expect(guid).toBe(VALID1);
    expect(issued.has(VALID1)).toBe(true);
  });

  it('retries past a guid the project index already holds', () => {
    const issued = new Set<string>();
    const guid = allocateGuid({
      taken: (g) => g === VALID1,
      issued,
      random: queueRandom([VALID1, VALID2]),
    });
    expect(guid).toBe(VALID2);
  });

  it('retries past a guid already issued earlier this send', () => {
    const issued = new Set<string>([VALID1]);
    const guid = allocateGuid({ taken: () => false, issued, random: queueRandom([VALID1, VALID2]) });
    expect(guid).toBe(VALID2);
    expect(issued.has(VALID2)).toBe(true);
  });

  it('rejects the all-zero guid without ever consulting taken/issued', () => {
    const guid = allocateGuid({
      taken: () => false,
      issued: new Set(),
      random: queueRandom([ALL_ZERO, VALID1]),
    });
    expect(guid).toBe(VALID1);
  });

  it('rejects the reserved built-in-resource family (both e000… and f000…)', () => {
    const guid = allocateGuid({
      taken: () => false,
      issued: new Set(),
      random: queueRandom([RESERVED_E, RESERVED_F, VALID1]),
    });
    expect(guid).toBe(VALID1);
  });

  it('gives up after 5 straight collisions rather than looping forever', () => {
    expect(() =>
      allocateGuid({ taken: () => true, issued: new Set(), random: queueRandom(Array(5).fill(VALID1)) }),
    ).toThrow(/5 attempts/);
  });
});

describe('buildMetaText — template guid replacement', () => {
  const template = [
    'fileFormatVersion: 2',
    `guid: ${VALID1}`,
    'ScriptedImporter:',
    '  internalIDToNameTable: []',
    '  externalObjects: {}',
    '  serializedVersion: 2',
    '  script: {fileID: 13804, guid: 0000000000000000e000000000000000, type: 0}',
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    '  nameOverride: HudPanel',
    '',
  ].join('\n');

  it('replaces only the guid: line, byte-exactly preserving the rest', () => {
    const out = buildMetaText('uxml', VALID2, template);
    expect(out).toContain(`guid: ${VALID2}`);
    expect(out).not.toContain(`guid: ${VALID1}`);
    // The importer's OWN script guid (a different, indented line) must survive
    // untouched — this is a project's real importer settings, e.g. a
    // hand-authored nameOverride, not something a new asset should reset.
    expect(out).toContain('script: {fileID: 13804, guid: 0000000000000000e000000000000000, type: 0}');
    expect(out).toContain('nameOverride: HudPanel');
  });

  it('falls back to the default when the template has no guid: line to replace', () => {
    const out = buildMetaText('uxml', VALID2, 'some: yaml\nwithout a guid line\n');
    expect(out).toContain('ScriptedImporter:');
    expect(out).toContain(`guid: ${VALID2}`);
  });
});

describe('buildMetaText — defaults', () => {
  it('is the UI-Builder-shaped default for uxml (importer fileID 13804)', () => {
    const out = buildMetaText('uxml', VALID1);
    expect(out).toContain('fileFormatVersion: 2');
    expect(out).toContain(`guid: ${VALID1}`);
    expect(out).toContain('ScriptedImporter:');
    expect(out).toContain('script: {fileID: 13804, guid: 0000000000000000e000000000000000, type: 0}');
  });

  it('is the UI-Builder-shaped default for uss (importer fileID 12385)', () => {
    const out = buildMetaText('uss', VALID1);
    expect(out).toContain('script: {fileID: 12385, guid: 0000000000000000e000000000000000, type: 0}');
  });

  it('falls back to the minimal form for a kind outside the known table', () => {
    const out = buildMetaText('bogus' as MetaKind, VALID1);
    expect(out).toBe(minimalMetaText(VALID1));
    expect(out).toBe(`fileFormatVersion: 2\nguid: ${VALID1}\n`);
  });
});

describe('extractGuidFromMeta', () => {
  it('reads the guid line, lowercased', () => {
    expect(extractGuidFromMeta(`fileFormatVersion: 2\nguid: ${VALID1.toUpperCase()}\n`)).toBe(VALID1);
  });

  it('is null for text with no guid: line', () => {
    expect(extractGuidFromMeta('fileFormatVersion: 2\n')).toBeNull();
  });
});

describe('styleSrcFor — src escaping', () => {
  it('matches the exact UI-Builder-shaped project:// form', () => {
    expect(styleSrcFor('Assets/UI/HUD.uss', VALID1)).toBe(
      `project://database/Assets/UI/HUD.uss?fileID=7433441132597879392&amp;guid=${VALID1}&amp;type=3#HUD`,
    );
  });

  it('XML-escapes an "&" in the path without double-escaping the literal &amp; separators', () => {
    const out = styleSrcFor('Assets/UI & Stuff/HUD.uss', VALID1);
    expect(out).toBe(
      `project://database/Assets/UI &amp; Stuff/HUD.uss?fileID=7433441132597879392&amp;guid=${VALID1}&amp;type=3#HUD`,
    );
    // One escaped "&" from the path plus the two literal &amp; separators — four
    // if the path's own "&" had been double-escaped instead of escaped once.
    expect(out.match(/&amp;/g)).toHaveLength(3);
  });
});

describe('relativeStyleSrc', () => {
  it('returns the escaped project-relative path with no guid query', () => {
    expect(relativeStyleSrc('Assets/UI & Stuff/HUD.uss')).toBe('Assets/UI &amp; Stuff/HUD.uss');
  });
});
