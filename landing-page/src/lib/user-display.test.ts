import { describe, it, expect } from 'vitest';
import { initialsFromEmail, planLabel } from './user-display';

describe('initialsFromEmail', () => {
    it('takes one letter from each of the first two name parts', () => {
        expect(initialsFromEmail('sourav.das120699@gmail.com')).toBe('SD');
        expect(initialsFromEmail('ada_lovelace@example.com')).toBe('AL');
        expect(initialsFromEmail('grace-hopper@navy.mil')).toBe('GH');
        expect(initialsFromEmail('jean+arcane@example.com')).toBe('JA');
    });

    it('uses a single letter when the local part is one word', () => {
        // "JO" for "john" reads like a name the user never gave; one letter is
        // the honest amount of information we actually have.
        expect(initialsFromEmail('john@example.com')).toBe('J');
    });

    it('ignores parts that carry no letter or digit', () => {
        expect(initialsFromEmail('bob..smith@example.com')).toBe('BS');
        expect(initialsFromEmail('..bob@example.com')).toBe('B');
    });

    it('starts from the first alphanumeric character in a part', () => {
        expect(initialsFromEmail('1password.9lives@example.com')).toBe('19');
    });

    it('never returns more than two characters', () => {
        expect(initialsFromEmail('a.b.c.d.e@example.com')).toHaveLength(2);
    });

    it('falls back to a placeholder rather than throwing on junk input', () => {
        // The avatar renders from a decoded JWT; a malformed claim must not
        // take the whole navbar down.
        for (const junk of ['', '@example.com', '@', '...@x.com']) {
            expect(initialsFromEmail(junk)).toBe('?');
        }
    });
});

describe('planLabel', () => {
    it('maps every server plan id to its display name', () => {
        expect(planLabel('free')).toBe('Free');
        expect(planLabel('pro')).toBe('Pro');
        expect(planLabel('proplus')).toBe('Pro+');
        expect(planLabel('ultra')).toBe('Ultra');
    });

    it('treats a missing plan as Free, matching the server default', () => {
        expect(planLabel(undefined)).toBe('Free');
        expect(planLabel('')).toBe('Free');
    });

    it('shows an unknown id rather than hiding it, so a new tier is visible', () => {
        // A tier added server-side should surface as something, not vanish or
        // be mislabelled as Free.
        expect(planLabel('enterprise')).toBe('Enterprise');
    });
});
