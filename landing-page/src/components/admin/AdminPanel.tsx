import { useState, useEffect, useCallback } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken, decodeToken,
    adminLogin, adminGetUsers, adminCreateUser, adminDeleteUser,
    adminGetFeedback, adminGetModelConfig, adminPutModelConfig,
    adminGetPricingConfig, adminPutPricingConfig, adminGrant,
    type AdminUserRow, type ModelRoutingDoc, type ModelPricingDoc, type ModelInfo,
} from "@/lib/auth";

type Tab = "users" | "feedback" | "models" | "pricing" | "grants";

interface FeedbackItem {
    id: number;
    rating: number;
    message: string;
    email: string;
    category: string;
    created_at: string;
}

// Internal keys stay low/mid/high; labels mirror the server's
// arcane-server/src/config/plans.ts INTENSITY_CONFIG.
const TIER_LABELS: Record<"low" | "mid" | "high", string> = {
    low: "Standard",
    mid: "Deep Think",
    high: "Max",
};

const GRANT_TIERS: { id: string; label: string }[] = [
    { id: "starter", label: "Starter $5" },
    { id: "pro", label: "Pro $25" },
    { id: "max", label: "Max $50" },
];

function fmtDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ─── Models tab: form state ───────────────────────────────────
// A separate editable shape from ModelRoutingDoc — executorHard is always a
// (possibly empty) string here, and gets omitted from the doc on save only
// when still empty, matching the brief's "empty ⇒ omit from doc".

interface TierFormRow {
    planner: string;
    executor: string;
    executorHard: string;
}

interface ModelsFormState {
    low: TierFormRow;
    mid: TierFormRow;
    high: TierFormRow;
    inline: string;
}

function routingDocToForm(doc: ModelRoutingDoc): ModelsFormState {
    const row = (t: { planner: string; executor: string; executorHard?: string }): TierFormRow => ({
        planner: t.planner, executor: t.executor, executorHard: t.executorHard ?? "",
    });
    return { low: row(doc.tiers.low), mid: row(doc.tiers.mid), high: row(doc.tiers.high), inline: doc.inline };
}

function formToRoutingDoc(form: ModelsFormState): ModelRoutingDoc {
    const tier = (t: TierFormRow) => {
        const executorHard = t.executorHard.trim();
        return executorHard
            ? { planner: t.planner.trim(), executor: t.executor.trim(), executorHard }
            : { planner: t.planner.trim(), executor: t.executor.trim() };
    };
    return {
        tiers: { low: tier(form.low), mid: tier(form.mid), high: tier(form.high) },
        inline: form.inline.trim(),
    };
}

// ─── Pricing tab: "Add model" row state ───────────────────────

interface NewModelFormState {
    slug: string;
    route: ModelInfo["route"];
    wireFormat: "" | "chat" | "responses";
    inputCostPer1M: number;
    outputCostPer1M: number;
    cachedInputCostPer1M: number;
    contextWindow: number;
    maxOutput: number;
}

const EMPTY_NEW_MODEL: NewModelFormState = {
    slug: "", route: "workers-ai", wireFormat: "",
    inputCostPer1M: 0, outputCostPer1M: 0, cachedInputCostPer1M: 0, contextWindow: 0, maxOutput: 0,
};

export default function AdminPanel() {
    const [state, setState] = useState<"loading" | "login" | "denied" | "ready">("loading");
    const [tab, setTab] = useState<Tab>("users");
    const [token, setToken] = useState<string>("");
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

    // Login form
    const [loginEmail, setLoginEmail] = useState("");
    const [loginPassword, setLoginPassword] = useState("");
    const [loginError, setLoginError] = useState("");
    const [loginLoading, setLoginLoading] = useState(false);

    // Users / Feedback data
    const [users, setUsers] = useState<AdminUserRow[]>([]);
    const [feedback, setFeedback] = useState<FeedbackItem[]>([]);

    // Users tab: create-user form
    const [newUserEmail, setNewUserEmail] = useState("");
    const [newUserPassword, setNewUserPassword] = useState("");

    // Models tab
    const [modelsForm, setModelsForm] = useState<ModelsFormState | null>(null);
    const [modelsIsDefault, setModelsIsDefault] = useState(false);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsSaving, setModelsSaving] = useState(false);

    // Pricing tab
    const [pricingDoc, setPricingDoc] = useState<ModelPricingDoc | null>(null);
    const [pricingIsDefault, setPricingIsDefault] = useState(false);
    const [pricingLoading, setPricingLoading] = useState(false);
    const [pricingSaving, setPricingSaving] = useState(false);
    const [newModel, setNewModel] = useState<NewModelFormState>(EMPTY_NEW_MODEL);

    // Grants tab
    const [grantEmail, setGrantEmail] = useState("");
    const [grantTier, setGrantTier] = useState(GRANT_TIERS[0]!.id);
    const [grantSubmitting, setGrantSubmitting] = useState(false);

    const showToast = useCallback((msg: string, type: "success" | "error" = "success") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    const initWithToken = useCallback((t: string) => {
        const decoded = decodeToken(t);
        if (!decoded || decoded.role !== "admin") {
            clearStoredToken();
            setState("denied");
            return;
        }
        setToken(t);
        setState("ready");
        loadAll(t);
    }, []);

    useEffect(() => {
        const t = getStoredToken();
        if (!t) {
            setState("login");
            return;
        }
        initWithToken(t);
    }, []);

    const handleAdminLogin = async () => {
        if (!loginEmail || !loginPassword) { setLoginError("Email and password required"); return; }
        setLoginLoading(true);
        setLoginError("");
        try {
            const data = await adminLogin(loginEmail, loginPassword);
            setStoredToken(data.token);
            initWithToken(data.token);
        } catch (err: any) {
            setLoginError(err.message || "Login failed");
        }
        setLoginLoading(false);
    };

    const loadAll = async (t: string) => {
        try {
            const [u, f] = await Promise.all([
                adminGetUsers(t),
                adminGetFeedback(t),
            ]);
            setUsers(u);
            setFeedback(f.feedback ?? []);
        } catch (err) {
            showToast("Failed to load data", "error");
        }
    };

    const loadModels = useCallback(async (t: string) => {
        setModelsLoading(true);
        try {
            const { value, isDefault } = await adminGetModelConfig(t);
            setModelsForm(routingDocToForm(value));
            setModelsIsDefault(isDefault);
        } catch (err: any) {
            showToast(err.message || "Failed to load model config", "error");
        }
        setModelsLoading(false);
    }, [showToast]);

    const loadPricing = useCallback(async (t: string) => {
        setPricingLoading(true);
        try {
            const { value, isDefault } = await adminGetPricingConfig(t);
            setPricingDoc(value);
            setPricingIsDefault(isDefault);
        } catch (err: any) {
            showToast(err.message || "Failed to load pricing config", "error");
        }
        setPricingLoading(false);
    }, [showToast]);

    // Lazy per-tab fetch — models/pricing docs can be large and are rarely
    // visited, so they load on first view rather than eagerly with users/feedback.
    useEffect(() => {
        if (state !== "ready") return;
        if (tab === "models" && !modelsForm && !modelsLoading) void loadModels(token);
        if (tab === "pricing" && !pricingDoc && !pricingLoading) void loadPricing(token);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, state, token]);

    // ─── User actions ───

    const handleCreateUser = async () => {
        if (!newUserEmail || !newUserPassword) { showToast("Email and password required", "error"); return; }
        try {
            await adminCreateUser(token, { email: newUserEmail, password: newUserPassword });
            setNewUserEmail(""); setNewUserPassword("");
            showToast("User created");
            setUsers(await adminGetUsers(token));
        } catch (err: any) { showToast(err.message, "error"); }
    };

    const handleDeleteUser = async (id: number) => {
        if (!confirm("Delete this user?")) return;
        try {
            await adminDeleteUser(token, id);
            showToast("User deleted");
            setUsers(await adminGetUsers(token));
        } catch (err: any) { showToast(err.message, "error"); }
    };

    // ─── Models tab actions ───

    const updateModelsTierField = (tierId: "low" | "mid" | "high", field: keyof TierFormRow, value: string) => {
        setModelsForm(f => f ? { ...f, [tierId]: { ...f[tierId], [field]: value } } : f);
    };

    const handleSaveModels = async () => {
        if (!modelsForm) return;
        setModelsSaving(true);
        try {
            await adminPutModelConfig(token, formToRoutingDoc(modelsForm));
            showToast("Model routing saved");
            setModelsIsDefault(false);
        } catch (err: any) {
            showToast(err.message || "Failed to save model config", "error");
        }
        setModelsSaving(false);
    };

    // ─── Pricing tab actions ───

    /** Merges `patch` over the existing model entry so any field this tab
     *  doesn't render (e.g. longContext) survives untouched — a round trip
     *  through GET -> edit -> PUT never drops unknown fields. */
    const updateModel = (slug: string, patch: Partial<ModelInfo>) => {
        setPricingDoc(prev => {
            if (!prev) return prev;
            const existing = prev.models[slug];
            if (!existing) return prev;
            return { ...prev, models: { ...prev.models, [slug]: { ...existing, ...patch } } };
        });
    };

    const setModelWireFormat = (slug: string, value: "" | "chat" | "responses") => {
        setPricingDoc(prev => {
            if (!prev) return prev;
            const existing = prev.models[slug];
            if (!existing) return prev;
            const { wireFormat, ...rest } = existing;
            const next: ModelInfo = value ? { ...rest, wireFormat: value } : rest;
            return { ...prev, models: { ...prev.models, [slug]: next } };
        });
    };

    const handleAddModel = () => {
        const slug = newModel.slug.trim();
        if (!slug) { showToast("Slug is required", "error"); return; }
        setPricingDoc(prev => {
            if (!prev) return prev;
            const info: ModelInfo = {
                route: newModel.route,
                inputCostPer1M: newModel.inputCostPer1M,
                outputCostPer1M: newModel.outputCostPer1M,
                cachedInputCostPer1M: newModel.cachedInputCostPer1M,
                contextWindow: newModel.contextWindow,
                maxOutput: newModel.maxOutput,
            };
            if (newModel.wireFormat) info.wireFormat = newModel.wireFormat;
            return { ...prev, models: { ...prev.models, [slug]: info } };
        });
        setNewModel(EMPTY_NEW_MODEL);
    };

    const handleSavePricing = async () => {
        if (!pricingDoc) return;
        setPricingSaving(true);
        try {
            await adminPutPricingConfig(token, pricingDoc);
            showToast("Pricing config saved");
            setPricingIsDefault(false);
        } catch (err: any) {
            showToast(err.message || "Failed to save pricing config", "error");
        }
        setPricingSaving(false);
    };

    // ─── Grants tab actions ───

    const handleGrant = async () => {
        if (!grantEmail) { showToast("Email is required", "error"); return; }
        setGrantSubmitting(true);
        try {
            const res = await adminGrant(token, { email: grantEmail, tier: grantTier });
            showToast(`Granted ${res.plan} to ${grantEmail} until ${fmtDate(res.periodEnd)}`);
            setGrantEmail("");
            // Refresh the Users tab's raw data so the grant is visible immediately.
            setUsers(await adminGetUsers(token));
        } catch (err: any) {
            showToast(err.message || "Failed to grant plan", "error");
        }
        setGrantSubmitting(false);
    };

    // ─── Loading / Denied states ───

    if (state === "loading") {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
        );
    }

    if (state === "login") {
        const loginInputClass = "h-10 rounded-md border border-border bg-secondary/50 px-3 text-sm text-foreground outline-none focus:border-primary transition-colors w-full";
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="glass rounded-2xl p-8 w-full max-w-sm">
                    <h1 className="font-display text-2xl font-bold mb-1 text-center">Admin Login</h1>
                    <p className="text-muted-foreground text-sm mb-6 text-center">Sign in with your admin account</p>

                    {loginError && (
                        <div className="mb-4 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive">
                            {loginError}
                        </div>
                    )}

                    <div className="flex flex-col gap-3">
                        <input
                            className={loginInputClass}
                            placeholder="Email"
                            type="email"
                            value={loginEmail}
                            onChange={e => setLoginEmail(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") handleAdminLogin(); }}
                        />
                        <input
                            className={loginInputClass}
                            placeholder="Password"
                            type="password"
                            value={loginPassword}
                            onChange={e => setLoginPassword(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") handleAdminLogin(); }}
                        />
                        <button
                            className="h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-50"
                            onClick={handleAdminLogin}
                            disabled={loginLoading}
                        >
                            {loginLoading ? "Signing in..." : "Sign In"}
                        </button>
                    </div>

                    <a href="/" className="block mt-4 text-center text-primary text-sm hover:underline">Back to home</a>
                </div>
            </div>
        );
    }

    if (state === "denied") {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="glass rounded-2xl p-8 text-center max-w-md">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
                        <svg className="w-8 h-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                    </div>
                    <h1 className="font-display text-2xl font-bold mb-2">Access Denied</h1>
                    <p className="text-muted-foreground text-sm">You don't have admin privileges to access this page.</p>
                    <a href="/" className="inline-block mt-4 text-primary text-sm hover:underline">Back to home</a>
                </div>
            </div>
        );
    }

    // ─── Admin Panel ───

    const inputClass = "h-8 rounded-md border border-border bg-secondary/50 px-2.5 text-sm text-foreground outline-none focus:border-primary transition-colors";
    const btnClass = "h-8 rounded-md px-3 text-xs font-semibold transition-all";
    const btnPrimary = `${btnClass} bg-primary text-primary-foreground hover:bg-primary/90`;
    const btnDanger = `${btnClass} bg-destructive/10 border border-destructive/20 text-destructive hover:bg-destructive/20`;
    const defaultsBadge = <span className="ml-2 rounded-full bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground align-middle">(defaults)</span>;

    const tabs: { id: Tab; label: string; count?: number }[] = [
        { id: "users", label: "Users", count: users.length },
        { id: "feedback", label: "Feedback", count: feedback.length },
        { id: "models", label: "Models" },
        { id: "pricing", label: "Pricing" },
        { id: "grants", label: "Grants" },
    ];

    return (
        <div className="container mx-auto px-4 py-24 max-w-5xl">
            <h1 className="font-display text-2xl font-bold mb-1">Admin Dashboard</h1>
            <p className="text-muted-foreground text-sm mb-6">Manage users, AI config, and plan grants</p>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-border/50 mb-6">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                            tab === t.id
                                ? "border-primary text-primary"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {t.label}
                        {t.count !== undefined && t.count > 0 && (
                            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-secondary px-1.5 py-0.5 text-xs">
                                {t.count}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Users Tab */}
            {tab === "users" && (
                <div>
                    <div className="flex flex-wrap gap-2 mb-4">
                        <input className={`${inputClass} w-52`} placeholder="Email" value={newUserEmail} onChange={e => setNewUserEmail(e.target.value)} />
                        <input className={`${inputClass} w-40`} placeholder="Password" value={newUserPassword} onChange={e => setNewUserPassword(e.target.value)} />
                        <button className={btnPrimary} onClick={handleCreateUser}>Add User</button>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border/50">
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Role</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Plan</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Credits</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Requests</th>
                                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Joined</th>
                                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {users.map(u => (
                                    <tr key={u.id} className="border-b border-border/30 hover:bg-secondary/20">
                                        <td className="px-3 py-2">{u.email}</td>
                                        <td className="px-3 py-2 text-muted-foreground">{u.role}</td>
                                        <td className="px-3 py-2 text-muted-foreground capitalize">{u.plan}</td>
                                        {/* Raw credits — the admin panel is the owner's tool and is
                                            explicitly exempt from the no-raw-credits directive. */}
                                        <td className="px-3 py-2 font-mono text-xs">{Math.round(u.credits).toLocaleString()}</td>
                                        <td className="px-3 py-2 font-mono text-xs">{u.usage.totalRequests}</td>
                                        <td className="px-3 py-2 text-muted-foreground text-xs">{new Date(u.createdAt).toLocaleDateString()}</td>
                                        <td className="px-3 py-2 text-right">
                                            <button className={btnDanger} onClick={() => handleDeleteUser(u.id)}>Delete</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Feedback Tab */}
            {tab === "feedback" && (
                <div>
                    {feedback.length === 0 ? (
                        <p className="text-muted-foreground text-sm py-8 text-center">No feedback submitted yet.</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {feedback.map(f => (
                                <div key={f.id} className="glass rounded-xl p-4">
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="flex gap-0.5">
                                            {[1, 2, 3, 4, 5].map(s => (
                                                <svg key={s} className={`w-4 h-4 ${s <= f.rating ? "text-primary" : "text-muted-foreground/30"}`} fill="currentColor" viewBox="0 0 24 24">
                                                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                                                </svg>
                                            ))}
                                        </div>
                                        <span className="text-xs text-muted-foreground capitalize rounded-full bg-secondary/50 px-2 py-0.5">{f.category}</span>
                                        <span className="text-xs text-muted-foreground ml-auto">{new Date(f.created_at).toLocaleDateString()}</span>
                                    </div>
                                    <p className="text-sm text-foreground">{f.message}</p>
                                    {f.email && <p className="text-xs text-muted-foreground mt-1">{f.email}</p>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Models Tab */}
            {tab === "models" && (
                <div>
                    <h2 className="text-sm font-semibold text-foreground mb-4">
                        Model routing
                        {modelsIsDefault && defaultsBadge}
                    </h2>
                    {modelsLoading || !modelsForm ? (
                        <p className="text-muted-foreground text-sm py-8 text-center">Loading…</p>
                    ) : (
                        <>
                            <div className="overflow-x-auto mb-4">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-border/50">
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tier</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Planner</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Executor</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Executor (hard)</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(["low", "mid", "high"] as const).map(tierId => (
                                            <tr key={tierId} className="border-b border-border/30">
                                                <td className="px-3 py-2 font-medium whitespace-nowrap">{TIER_LABELS[tierId]}</td>
                                                <td className="px-3 py-2">
                                                    <input
                                                        className={`${inputClass} w-full`}
                                                        value={modelsForm[tierId].planner}
                                                        onChange={e => updateModelsTierField(tierId, "planner", e.target.value)}
                                                    />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input
                                                        className={`${inputClass} w-full`}
                                                        value={modelsForm[tierId].executor}
                                                        onChange={e => updateModelsTierField(tierId, "executor", e.target.value)}
                                                    />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input
                                                        className={`${inputClass} w-full`}
                                                        placeholder="optional, high tier only"
                                                        value={modelsForm[tierId].executorHard}
                                                        onChange={e => updateModelsTierField(tierId, "executorHard", e.target.value)}
                                                    />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="flex items-center gap-2 mb-6">
                                <label className="text-sm text-muted-foreground w-56 shrink-0">Inline (tab completions)</label>
                                <input
                                    className={`${inputClass} w-full max-w-md`}
                                    value={modelsForm.inline}
                                    onChange={e => setModelsForm(f => f ? { ...f, inline: e.target.value } : f)}
                                />
                            </div>

                            <button className={btnPrimary} onClick={handleSaveModels} disabled={modelsSaving}>
                                {modelsSaving ? "Saving…" : "Save"}
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* Pricing Tab */}
            {tab === "pricing" && (
                <div>
                    <h2 className="text-sm font-semibold text-foreground mb-4">
                        Model pricing
                        {pricingIsDefault && defaultsBadge}
                    </h2>
                    {pricingLoading || !pricingDoc ? (
                        <p className="text-muted-foreground text-sm py-8 text-center">Loading…</p>
                    ) : (
                        <>
                            <div className="overflow-x-auto mb-4">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-border/50">
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Slug</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Route</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Wire format</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Input $/1M</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Output $/1M</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cached input $/1M</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Context window</th>
                                            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Max output</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {Object.entries(pricingDoc.models).sort(([a], [b]) => a.localeCompare(b)).map(([slug, m]) => (
                                            <tr key={slug} className="border-b border-border/30">
                                                <td className="px-3 py-2 font-mono text-xs">{slug}</td>
                                                <td className="px-3 py-2">
                                                    <select
                                                        className={inputClass}
                                                        value={m.route}
                                                        onChange={e => updateModel(slug, { route: e.target.value as ModelInfo["route"] })}
                                                    >
                                                        <option value="workers-ai">workers-ai</option>
                                                        <option value="unified">unified</option>
                                                        <option value="direct">direct</option>
                                                    </select>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <select
                                                        className={inputClass}
                                                        value={m.wireFormat ?? ""}
                                                        onChange={e => setModelWireFormat(slug, e.target.value as "" | "chat" | "responses")}
                                                    >
                                                        <option value="">—</option>
                                                        <option value="chat">chat</option>
                                                        <option value="responses">responses</option>
                                                    </select>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input type="number" className={`${inputClass} w-24`} value={m.inputCostPer1M}
                                                        onChange={e => updateModel(slug, { inputCostPer1M: Number(e.target.value) })} />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input type="number" className={`${inputClass} w-24`} value={m.outputCostPer1M}
                                                        onChange={e => updateModel(slug, { outputCostPer1M: Number(e.target.value) })} />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input type="number" className={`${inputClass} w-24`} value={m.cachedInputCostPer1M}
                                                        onChange={e => updateModel(slug, { cachedInputCostPer1M: Number(e.target.value) })} />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input type="number" className={`${inputClass} w-28`} value={m.contextWindow}
                                                        onChange={e => updateModel(slug, { contextWindow: Number(e.target.value) })} />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input type="number" className={`${inputClass} w-24`} value={m.maxOutput}
                                                        onChange={e => updateModel(slug, { maxOutput: Number(e.target.value) })} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* Add model row */}
                            <div className="flex flex-wrap items-end gap-2 mb-6 glass rounded-xl p-3">
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Slug</label>
                                    <input className={`${inputClass} w-40`} value={newModel.slug} onChange={e => setNewModel(m => ({ ...m, slug: e.target.value }))} />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Route</label>
                                    <select className={inputClass} value={newModel.route} onChange={e => setNewModel(m => ({ ...m, route: e.target.value as ModelInfo["route"] }))}>
                                        <option value="workers-ai">workers-ai</option>
                                        <option value="unified">unified</option>
                                        <option value="direct">direct</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Wire format</label>
                                    <select className={inputClass} value={newModel.wireFormat} onChange={e => setNewModel(m => ({ ...m, wireFormat: e.target.value as "" | "chat" | "responses" }))}>
                                        <option value="">—</option>
                                        <option value="chat">chat</option>
                                        <option value="responses">responses</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Input $/1M</label>
                                    <input type="number" className={`${inputClass} w-24`} value={newModel.inputCostPer1M}
                                        onChange={e => setNewModel(m => ({ ...m, inputCostPer1M: Number(e.target.value) }))} />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Output $/1M</label>
                                    <input type="number" className={`${inputClass} w-24`} value={newModel.outputCostPer1M}
                                        onChange={e => setNewModel(m => ({ ...m, outputCostPer1M: Number(e.target.value) }))} />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Cached input $/1M</label>
                                    <input type="number" className={`${inputClass} w-28`} value={newModel.cachedInputCostPer1M}
                                        onChange={e => setNewModel(m => ({ ...m, cachedInputCostPer1M: Number(e.target.value) }))} />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Context window</label>
                                    <input type="number" className={`${inputClass} w-28`} value={newModel.contextWindow}
                                        onChange={e => setNewModel(m => ({ ...m, contextWindow: Number(e.target.value) }))} />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-xs text-muted-foreground">Max output</label>
                                    <input type="number" className={`${inputClass} w-24`} value={newModel.maxOutput}
                                        onChange={e => setNewModel(m => ({ ...m, maxOutput: Number(e.target.value) }))} />
                                </div>
                                <button className={btnPrimary} onClick={handleAddModel}>Add model</button>
                            </div>

                            <div className="flex flex-wrap items-center gap-6 mb-6">
                                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                                    Gateway fee
                                    <input type="number" step="0.01" className={`${inputClass} w-24`} value={pricingDoc.gatewayFee}
                                        onChange={e => setPricingDoc(d => d ? { ...d, gatewayFee: Number(e.target.value) } : d)} />
                                </label>
                                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                                    Margin
                                    <input type="number" step="0.01" className={`${inputClass} w-24`} value={pricingDoc.margin}
                                        onChange={e => setPricingDoc(d => d ? { ...d, margin: Number(e.target.value) } : d)} />
                                </label>
                            </div>

                            <button className={btnPrimary} onClick={handleSavePricing} disabled={pricingSaving}>
                                {pricingSaving ? "Saving…" : "Save"}
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* Grants Tab */}
            {tab === "grants" && (
                <div className="max-w-md">
                    <div className="flex flex-col gap-3">
                        <input
                            className={`${inputClass} w-full`}
                            placeholder="Email"
                            value={grantEmail}
                            onChange={e => setGrantEmail(e.target.value)}
                        />
                        <select className={`${inputClass} w-full`} value={grantTier} onChange={e => setGrantTier(e.target.value)}>
                            {GRANT_TIERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        <button className={btnPrimary} onClick={handleGrant} disabled={grantSubmitting}>
                            {grantSubmitting ? "Granting…" : "Grant"}
                        </button>
                    </div>
                </div>
            )}

            {/* Toast */}
            {toast && (
                <div className={`fixed bottom-5 right-5 rounded-lg px-4 py-3 text-sm font-medium text-white z-50 animate-[fadeIn_0.2s_ease] ${
                    toast.type === "success" ? "bg-green-600" : "bg-destructive"
                }`}>
                    {toast.msg}
                </div>
            )}
        </div>
    );
}
