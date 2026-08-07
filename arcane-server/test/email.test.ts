import { describe, it, expect } from 'vitest';
import { sendVerificationEmail, sendPasswordResetEmail, sendMagicLinkEmail } from '../src/lib/email.ts';
import type { EmailSender } from '../src/types.ts';

type SentMessage = Parameters<EmailSender['send']>[0];

function fakeEnv(capture: SentMessage[], sendImpl?: EmailSender['send']) {
    return {
        EMAIL: {
            send: sendImpl ?? (async (m: SentMessage) => { capture.push(m); return { messageId: 'mid-1' }; }),
        },
        WEB_BASE_URL: 'https://dev.arcaneai.org',
        EMAIL_FROM: 'no-reply@arcaneai.org',
    };
}

describe('email lib', () => {
    it('sendVerificationEmail sends html+text containing the verify link', async () => {
        const calls: SentMessage[] = [];
        await sendVerificationEmail(fakeEnv(calls), 'user@test.dev', 'tok123');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.to).toBe('user@test.dev');
        expect(calls[0]!.from).toEqual({ email: 'no-reply@arcaneai.org', name: 'Arcane' });
        expect(calls[0]!.subject).toBe('Verify your Arcane email');
        expect(calls[0]!.text).toContain('https://dev.arcaneai.org/verify?token=tok123');
        expect(calls[0]!.html).toContain('https://dev.arcaneai.org/verify?token=tok123');
    });

    it('sendPasswordResetEmail links to /reset', async () => {
        const calls: SentMessage[] = [];
        await sendPasswordResetEmail(fakeEnv(calls), 'user@test.dev', 'tok456');
        expect(calls[0]!.subject).toBe('Reset your Arcane password');
        expect(calls[0]!.text).toContain('https://dev.arcaneai.org/reset?token=tok456');
        expect(calls[0]!.html).toContain('https://dev.arcaneai.org/reset?token=tok456');
    });

    it('sendMagicLinkEmail links to /auth?code= — the branch AuthHub exchanges', async () => {
        const calls: SentMessage[] = [];
        await sendMagicLinkEmail(fakeEnv(calls), 'user@test.dev', 'tok789');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.to).toBe('user@test.dev');
        expect(calls[0]!.subject).toBe('Your Arcane sign-in link');
        expect(calls[0]!.text).toContain('https://dev.arcaneai.org/auth?code=tok789');
        expect(calls[0]!.html).toContain('https://dev.arcaneai.org/auth?code=tok789');
    });

    it('never throws when the binding rejects (waitUntil safety)', async () => {
        const failing = async () => {
            throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER_NOT_VERIFIED' });
        };
        await expect(sendVerificationEmail(fakeEnv([], failing), 'user@test.dev', 't')).resolves.toBeUndefined();
    });

    it('no-ops without the EMAIL binding (tests / local dev)', async () => {
        const env = { EMAIL: undefined, WEB_BASE_URL: 'https://dev.arcaneai.org', EMAIL_FROM: 'no-reply@arcaneai.org' };
        await expect(sendVerificationEmail(env, 'user@test.dev', 't')).resolves.toBeUndefined();
    });
});
