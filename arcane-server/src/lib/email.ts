import type { AppEnv } from '../types.ts';
import { logAuthEvent } from './log.ts';

type EmailEnv = Pick<AppEnv['Bindings'], 'EMAIL' | 'WEB_BASE_URL' | 'EMAIL_FROM'>;

/** Sends via the Email Service binding. NEVER throws — callers run inside
 *  c.executionCtx.waitUntil and a failed email must not fail the request. */
async function sendEmail(env: EmailEnv, to: string, subject: string, text: string, html: string): Promise<void> {
    if (!env.EMAIL) {
        logAuthEvent('email_skipped', { reason: 'no_binding', subject });
        return;
    }
    try {
        const { messageId } = await env.EMAIL.send({
            to,
            from: { email: env.EMAIL_FROM, name: 'Arcane' },
            subject,
            text,
            html,
        });
        logAuthEvent('email_sent', { subject, messageId });
    } catch (err) {
        logAuthEvent('email_send_failed', {
            subject,
            code: (err as { code?: string }).code ?? null,
            message: (err as Error).message,
        });
    }
}

export async function sendVerificationEmail(env: EmailEnv, to: string, code: string): Promise<void> {
    // No link: the code is typed back into the tab that signed up, so the user
    // never leaves the flow and any pending editor sign-in survives.
    await sendEmail(
        env, to, `${code} is your Arcane verification code`,
        `Welcome to Arcane!\n\nYour verification code is ${code}\n\nEnter it in the tab where you signed up. The code expires in 15 minutes and can be used once. If you didn't create an Arcane account, ignore this email.`,
        `<p>Welcome to Arcane!</p><p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Enter it in the tab where you signed up. The code expires in 15 minutes and can be used once.</p><p>If you didn't create an Arcane account, ignore this email.</p>`,
    );
}

export async function sendPasswordResetEmail(env: EmailEnv, to: string, token: string): Promise<void> {
    const link = `${env.WEB_BASE_URL}/reset?token=${token}`;
    await sendEmail(
        env, to, 'Reset your Arcane password',
        `Someone requested a password reset for your Arcane account.\n\nSet a new password here:\n${link}\n\nThe link expires in 30 minutes and can be used once. If this wasn't you, ignore this email — your password is unchanged.`,
        `<p>Someone requested a password reset for your Arcane account.</p><p><a href="${link}">Set a new password</a></p><p>Or paste this link into your browser:<br>${link}</p><p>The link expires in 30 minutes and can be used once. If this wasn't you, ignore this email — your password is unchanged.</p>`,
    );
}
