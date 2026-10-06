type LeaseInvoke = (command: string, args: { windowLabel: string; lease: string }) => Promise<unknown>;

/** Each React effect owns a generation; late cleanup cannot release its successor. */
export function createSetupLease(windowLabel: string, lease: string, invoke: LeaseInvoke) {
  let cancelled = false;
  let claiming = false;
  let claimed = false;
  const args = { windowLabel, lease };
  const releaseNative = async () => { await invoke('release_editor_setup', args); };
  return {
    async claim(): Promise<boolean> {
      if (cancelled || claiming) return false;
      if (claimed) return true;
      claiming = true;
      try {
        const allowed = await invoke('claim_editor_setup', args) === true;
        if (cancelled) {
          if (allowed) await releaseNative();
          return false;
        }
        claimed = allowed;
        return allowed;
      } finally { claiming = false; }
    },
    async release(): Promise<void> {
      cancelled = true;
      if (claimed) {
        claimed = false;
        await releaseNative();
      }
    },
  };
}
