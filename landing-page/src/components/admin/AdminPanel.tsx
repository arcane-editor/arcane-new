import { useState, useEffect, useCallback } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken, decodeToken, apiLogin,
    adminGetUsers, adminCreateUser, adminDeleteUser,
    adminGetFeedback,
} from "@/lib/auth";

type Tab = "users" | "feedback";

interface AdminUser {
    id: number;
    email: string;
    role: string;
    createdAt: string;
    usage: { totalRequests: number };
}

interface FeedbackItem {
    id: number;
    rating: number;
    message: string;
    email: string;
    category: string;
    created_at: string;
}

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

    // Data
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [feedback, setFeedback] = useState<FeedbackItem[]>([]);

    // Forms
    const [newUserEmail, setNewUserEmail] = useState("");
    const [newUserPassword, setNewUserPassword] = useState("");

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
            const data = await apiLogin(loginEmail, loginPassword);
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

    // ─── Loading / Denied states ───

    if (state === "loading") {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
        );
    }

    if (state === "login") {
        const inputClass = "h-10 rounded-md border border-border bg-secondary/50 px-3 text-sm text-foreground outline-none focus:border-primary transition-colors w-full";
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
                            className={inputClass}
                            placeholder="Email"
                            type="email"
                            value={loginEmail}
                            onChange={e => setLoginEmail(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") handleAdminLogin(); }}
                        />
                        <input
                            className={inputClass}
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

    const tabs: { id: Tab; label: string; count?: number }[] = [
        { id: "users", label: "Users", count: users.length },
        { id: "feedback", label: "Feedback", count: feedback.length },
    ];

    return (
        <div className="container mx-auto px-4 py-24 max-w-5xl">
            <h1 className="font-display text-2xl font-bold mb-1">Admin Dashboard</h1>
            <p className="text-muted-foreground text-sm mb-6">Manage users and view feedback</p>

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
