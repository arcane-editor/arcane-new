import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { adminAccess } from '../middleware/admin.ts';
import { signAdminJwt } from '../middleware/auth.ts';
import {
    findAllUsersWithUsage, createUser, deleteUser, findUserById,
    updatePasswordBumpVersion,
    getCurrentPeriodStart,
    findAllFeedback,
    findUserByEmail, grantPlanCredits,
} from '../lib/db.ts';
import { hashPassword, digestsMatch } from '../lib/crypto.ts';
import {
    readConfigDoc, putConfigDoc, getEffectivePricing,
    validateModelRoutingDoc, validateModelPricingDoc,
} from '../lib/app-config.ts';
import type { ModelRoutingDoc, ModelPricingDoc } from '../lib/app-config.ts';
import { DEFAULT_MODEL_ROUTING } from '../config/plans.ts';
import { GATEWAY_FEE, MARGIN, isPaidPlan, tierGrantMicro, microToCredits } from '../config/tiers.ts';
import { MODEL_CATALOG } from '../lib/costs.ts';

export const adminRouter = new Hono<AppEnv>();

// Owner's email — the only identity POST /v1/admin/login accepts alongside
// ADMIN_PASSWORD. Deliberate code constant (owner directive), not env-driven.
export const OWNER_EMAIL = 'sourav.das120699@gmail.com';

// Registered ABOVE the adminAccess() `.use` below — Hono composes
// middleware/routes in registration order, and this handler returns a
// Response without calling next(), so a request that matches this exact
// route never reaches adminAccess(). That's necessary: this is how an
// env-admin token is minted in the first place.
adminRouter.post('/v1/admin/login', async (c) => {
    if (!c.env.ADMIN_PASSWORD) {
        return c.json({ error: 'Admin login is not configured', code: 'admin_unconfigured' }, 503);
    }

    const { email, password } = await c.req.json<Record<string, unknown>>();
    if (typeof email !== 'string' || typeof password !== 'string') {
        return c.json({ error: 'email and password are required' }, 400);
    }

    // The password check is a constant-time digest compare (lib/crypto.ts)
    // and MUST run unconditionally — never short-circuited by the email
    // check — so response timing never reveals which half (email vs
    // password) was wrong. Both failure modes return the identical 401 body.
    const emailOk = email === OWNER_EMAIL;
    const passwordOk = await digestsMatch(password, c.env.ADMIN_PASSWORD);
    if (!emailOk || !passwordOk) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = await signAdminJwt(OWNER_EMAIL, c.env.JWT_SECRET);
    return c.json({ token });
});

// All other admin routes require adminAccess() (env-admin token OR a DB
// user row with role = 'admin').
adminRouter.use('/v1/admin/*', adminAccess());

// ─── API: Users ──────────────────────────────────────────────

adminRouter.get('/v1/admin/users', async (c) => {
    const periodStart = getCurrentPeriodStart();
    const users = await findAllUsersWithUsage(c.env.arcane_db, periodStart);

    return c.json(users.map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.created_at,
        plan: u.plan,
        credits: microToCredits(u.plan_credits_micro + u.topup_credits_micro),
        usage: {
            totalRequests: u.total_requests ?? 0,
        },
    })));
});

adminRouter.post('/v1/admin/users', async (c) => {
    const { email, password } = await c.req.json();
    if (!email || !password) {
        return c.json({ error: 'email and password are required' }, 400);
    }
    const { hash, salt } = await hashPassword(password);
    const user = await createUser(c.env.arcane_db, {
        email, passwordHash: hash, salt, emailVerified: true,
    });
    return c.json({ id: user.id, email: user.email, role: user.role }, 201);
});

adminRouter.put('/v1/admin/users/:id', async (c) => {
    const { id } = c.req.param();
    const updates = await c.req.json<{ password?: string }>();
    if (!updates.password) {
        const user = await findUserById(c.env.arcane_db, parseInt(id));
        if (!user) return c.json({ error: 'User not found' }, 404);
        return c.json({ id: user.id, email: user.email, role: user.role });
    }
    const { hash, salt } = await hashPassword(updates.password);
    // token_version bump — an admin password set revokes the user's sessions.
    const user = await updatePasswordBumpVersion(c.env.arcane_db, parseInt(id), hash, salt);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ id: user.id, email: user.email, role: user.role });
});

adminRouter.delete('/v1/admin/users/:id', async (c) => {
    const { id } = c.req.param();
    const deleted = await deleteUser(c.env.arcane_db, parseInt(id));
    if (!deleted) return c.json({ error: 'User not found' }, 404);
    return c.json({ ok: true });
});

// ─── API: Feedback (admin view) ──────────────────────────────

adminRouter.get('/v1/admin/feedback', async (c) => {
    const feedback = await findAllFeedback(c.env.arcane_db);
    return c.json({ feedback });
});

// ─── API: Config (model routing + pricing) ───────────────────
//
// Both GET routes read the raw stored doc (readConfigDoc — uncached, unlike
// the getModelRouting/getEffectivePricing getters other routes use) and
// re-validate it here so the admin panel can distinguish "no row yet" from
// "a row exists but is invalid" (both report isDefault:true, but only the
// latter has a non-null updatedAt while still serving the code default).

adminRouter.get('/v1/admin/config/models', async (c) => {
    const row = await readConfigDoc(c.env.arcane_db, 'model_routing');

    // Validate against the EFFECTIVE catalog — the same basis PUT
    // /config/models itself validates against — so a doc that PUT just
    // accepted (e.g. one referencing a model that resolves only through a
    // pricing override) always round-trips here as isDefault:false, rather
    // than this route re-deciding validity against a narrower catalog than
    // the one that accepted it.
    const { catalog } = await getEffectivePricing(c.env.arcane_db);

    let value: ModelRoutingDoc = DEFAULT_MODEL_ROUTING;
    let isDefault = true;
    if (row) {
        try {
            const parsed: unknown = JSON.parse(row.raw);
            if (validateModelRoutingDoc(parsed, catalog) === null) {
                value = parsed as ModelRoutingDoc;
                isDefault = false;
            }
        } catch {
            // malformed JSON -> falls back to the default, isDefault stays true
        }
    }

    return c.json({ value, isDefault, updatedAt: row?.updatedAt ?? null });
});

adminRouter.put('/v1/admin/config/models', async (c) => {
    const body: unknown = await c.req.json();
    const { catalog } = await getEffectivePricing(c.env.arcane_db);

    const error = validateModelRoutingDoc(body, catalog);
    if (error) return c.json({ error, code: 'invalid_config' }, 400);

    await putConfigDoc(c.env.arcane_db, 'model_routing', body as object);
    return c.json({ ok: true });
});

adminRouter.get('/v1/admin/config/pricing', async (c) => {
    const row = await readConfigDoc(c.env.arcane_db, 'model_pricing');

    let value: ModelPricingDoc = { models: {}, gatewayFee: GATEWAY_FEE, margin: MARGIN };
    let isDefault = true;
    if (row) {
        try {
            const parsed: unknown = JSON.parse(row.raw);
            if (validateModelPricingDoc(parsed) === null) {
                value = parsed as ModelPricingDoc;
                isDefault = false;
            }
        } catch {
            // malformed JSON -> falls back to the default, isDefault stays true
        }
    }

    return c.json({ value, isDefault, updatedAt: row?.updatedAt ?? null });
});

adminRouter.put('/v1/admin/config/pricing', async (c) => {
    const body: unknown = await c.req.json();

    const error = validateModelPricingDoc(body);
    if (error) return c.json({ error, code: 'invalid_config' }, 400);

    // Orphan rule: a model currently referenced by the CURRENT routing doc
    // (every tier's planner/executor/executorHard, plus inline) must still
    // resolve once this doc replaces the pricing overrides — otherwise the
    // very next request routed to it would have no catalog entry to price.
    //
    // Deliberately NOT the cached getModelRouting(db) getter here: that
    // getter re-validates the stored doc against the STATIC MODEL_CATALOG
    // only (see app-config.ts's getModelRouting — a documented, Task-2
    // design choice), so a routing doc that legitimately references a
    // model resolvable only through a pricing override (exactly the case
    // this orphan check exists to protect) would already fail ITS
    // validation and silently fall back to DEFAULT_MODEL_ROUTING — masking
    // the very reference we need to see, and logging a spurious anomaly on
    // every unrelated pricing PUT. Instead, read the raw stored doc and
    // validate it against the catalog effective RIGHT NOW (before this PUT
    // overwrites it) — the same effectiveCatalog basis PUT /config/models
    // itself validates against, so "currently routed" here means exactly
    // what the last accepted PUT /config/models call considered valid.
    const { catalog: currentCatalog } = await getEffectivePricing(c.env.arcane_db);
    const routingRow = await readConfigDoc(c.env.arcane_db, 'model_routing');
    let routing: ModelRoutingDoc = DEFAULT_MODEL_ROUTING;
    if (routingRow) {
        try {
            const parsedRouting: unknown = JSON.parse(routingRow.raw);
            if (validateModelRoutingDoc(parsedRouting, currentCatalog) === null) {
                routing = parsedRouting as ModelRoutingDoc;
            }
        } catch {
            // malformed JSON -> treat as "no live routing doc", same as getModelRouting
        }
    }

    const mergedCatalog = { ...MODEL_CATALOG, ...(body as ModelPricingDoc).models };

    const referenced = new Set<string>([routing.inline]);
    for (const tier of Object.values(routing.tiers)) {
        referenced.add(tier.planner);
        referenced.add(tier.executor);
        if (tier.executorHard) referenced.add(tier.executorHard);
    }
    for (const modelId of referenced) {
        if (!mergedCatalog[modelId]) {
            return c.json({
                error: `cannot orphan model '${modelId}': it is referenced by the current routing config`,
                code: 'invalid_config',
            }, 400);
        }
    }

    await putConfigDoc(c.env.arcane_db, 'model_pricing', body as object);
    return c.json({ ok: true });
});

// ─── API: Comp grants ─────────────────────────────────────────
//
// Deliberately writes NO subscriptions row. A real Dodo subscriber always
// has one (upsertSubscription, from the webhook); its absence is exactly
// what makes refreshAndGetBalance's lazy comp expiry revert this grant to
// free once plan_period_end passes, instead of protecting it forever.

const GRANT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

adminRouter.post('/v1/admin/grants', async (c) => {
    const { email, tier } = await c.req.json<{ email?: string; tier?: string }>();

    if (typeof email !== 'string' || email.length === 0) {
        return c.json({ error: 'email is required' }, 400);
    }
    if (typeof tier !== 'string' || !isPaidPlan(tier)) {
        return c.json({ error: `tier must be a paid plan, got: ${tier}`, code: 'invalid_tier' }, 400);
    }

    const user = await findUserByEmail(c.env.arcane_db, email);
    if (!user) return c.json({ error: 'User not found', code: 'user_not_found' }, 404);

    const periodEnd = new Date(Date.now() + GRANT_PERIOD_MS).toISOString();
    await grantPlanCredits(c.env.arcane_db, user.id, tier, tierGrantMicro(tier), periodEnd);

    return c.json({ ok: true, userId: user.id, plan: tier, periodEnd });
});
