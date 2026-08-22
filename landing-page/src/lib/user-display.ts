// Presentation helpers for the signed-in user. Kept pure and separate from
// `auth.ts` (network + storage) so they can be unit-tested without a DOM.
//
// There is no `name` column on the users table — the only identity we hold is
// the email — so everything here derives from that. If GitHub's `name` /
// `avatar_url` are ever persisted at sign-in, the avatar should prefer them.

/** Plan ids come from `arcane-server/src/config/tiers.ts` (free/starter/pro/max). */
const PLAN_NAMES: Record<string, string> = {
    free: 'Free',
    starter: 'Starter',
    pro: 'Pro',
    max: 'Max',
};

/**
 * Up to two initials for the avatar, from the email's local part.
 *
 * `sourav.das120699@gmail.com` → `SD`, `john@example.com` → `J`. One word gives
 * one letter on purpose: inventing a second from "john" would show the user a
 * name they never entered. Returns `?` rather than throwing — this renders from
 * a decoded JWT, and a malformed claim must not break the navbar.
 */
export function initialsFromEmail(email: string): string {
    const local = (email ?? '').split('@')[0] ?? '';
    const initials = local
        .split(/[.\-_+]/)
        // A part like `..` in `bob..smith` carries no initial to take.
        .map(part => part.match(/[a-z0-9]/i)?.[0])
        .filter((c): c is string => Boolean(c))
        .slice(0, 2)
        .join('');
    return initials ? initials.toUpperCase() : '?';
}

/**
 * Display name for a plan id. An id we don't know is title-cased and shown
 * as-is: a tier added server-side should be visible, never silently relabelled
 * as Free.
 */
export function planLabel(plan: string | undefined | null): string {
    if (!plan) return PLAN_NAMES.free!;
    return PLAN_NAMES[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}
