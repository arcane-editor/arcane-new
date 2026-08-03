import { create } from 'zustand';

// App-wide connectivity signal. Seeded from navigator.onLine, kept fresh by
// window online/offline events + a 30s re-sync (initConnectivityListeners in
// App.tsx), and pessimistically flipped offline by any fetch network-throw
// (navigator.onLine can report true while requests fail — belt & suspenders;
// the 30s re-sync heals a false offline).
interface ConnectivityState {
    online: boolean;
    setOnline: (online: boolean) => void;
    reportFetchFailure: () => void;
}

// bun:test (and some non-browser hosts) expose a stub `navigator` whose
// `onLine` is not a real boolean — default optimistic (online) unless the
// host genuinely reports offline.
function readNavigatorOnline(): boolean {
    if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true;
    return navigator.onLine;
}

export const useConnectivityStore = create<ConnectivityState>((set) => ({
    online: readNavigatorOnline(),
    setOnline: (online) => set({ online }),
    reportFetchFailure: () => set({ online: false }),
}));

/** Install window listeners + periodic re-sync. Returns a cleanup fn. */
export function initConnectivityListeners(): () => void {
    const sync = () => useConnectivityStore.getState().setOnline(readNavigatorOnline());
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    const timer = window.setInterval(sync, 30_000);
    sync();
    return () => {
        window.removeEventListener('online', sync);
        window.removeEventListener('offline', sync);
        window.clearInterval(timer);
    };
}
