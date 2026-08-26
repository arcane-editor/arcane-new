import { describe, it, expect } from 'vitest';
import { sendVerificationEmail, sendPasswordResetEmail } from '../src/lib/email.ts';
import type { EmailSender } from '../src/types.ts';

type SentMessage = Parameters<EmailSender['send']>[0];

function fakeEnv(capture: SentMessage[], sendImpl?: EmailSender['send']) {
    return {
        EMAIL: {
            send: sendImpl ?? (async (m: SentMessage) => { capture.push(m); return { messageId: 'mid-1' }; }),
        },
        WEB_BASE_URL: 'https://dev.unityide.app',
        EMAIL_FROM: 'no-reply@unityide.app',
    };
}

describe('email lib', () => {
    it('sendVerificationEmail carries the code in the subject and both bodies, with no link', async () => {
        const calls: SentMessage[] = [];
        await sendVerificationEmail(fakeEnv(calls), 'user@test.dev', '481920');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.to).toBe('user@test.dev');
        expect(calls[0]!.from).toEqual({ email: 'no-reply@unityide.app', name: 'UnityIDE' });
        // Leading the subject with the code lets clients preview it unopened.
        expect(calls[0]!.subject).toBe('481920 is your UnityIDE verification code');
        expect(calls[0]!.text).toContain('481920');
        expect(calls[0]!.html).toContain('481920');
        // The code is typed back into the signup tab — a link would defeat that.
        expect(calls[0]!.html).not.toContain('href');
    });

    it('sendPasswordResetEmail links to /reset', async () => {
        const calls: SentMessage[] = [];
        await sendPasswordResetEmail(fakeEnv(calls), 'user@test.dev', 'tok456');
        expect(calls[0]!.subject).toBe('Reset your UnityIDE password');
        expect(calls[0]!.text).toContain('https://dev.unityide.app/reset?token=tok456');
        expect(calls[0]!.html).toContain('https://dev.unityide.app/reset?token=tok456');
    });

    it('never throws when the binding rejects (waitUntil safety)', async () => {
        const failing = async () => {
            throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER_NOT_VERIFIED' });
        };
        await expect(sendVerificationEmail(fakeEnv([], failing), 'user@test.dev', 't')).resolves.toBeUndefined();
    });

    it('no-ops without the EMAIL binding (tests / local dev)', async () => {
        const env = { EMAIL: undefined, WEB_BASE_URL: 'https://dev.unityide.app', EMAIL_FROM: 'no-reply@unityide.app' };
        await expect(sendVerificationEmail(env, 'user@test.dev', 't')).resolves.toBeUndefined();
    });
});
