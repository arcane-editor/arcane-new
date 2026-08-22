import { describe, it, expect } from 'bun:test';
import {
  canUseExternalAgents,
  externalAgentStatus,
  refuseSendReason,
  showsUpgradeCta,
  EXTERNAL_AGENT_STATUS_TITLE,
  type ExternalAgentGate,
  showsRetryCta,
  EXTERNAL_AGENT_STATUS_LABEL,
} from './external-agent-gate';
import type { ExternalAgentStatus } from './external-agent-gate';

// acpEnabled: null throughout this base — these tests exercise the offline
// (plan-based) fallback path. The `acpEnabled` describe block below covers
// the server-config-decides path.
const base: ExternalAgentGate = { loggedIn: true, online: true, plan: 'pro', acpEnabled: null };
const g = (o: Partial<ExternalAgentGate> = {}): ExternalAgentGate => ({ ...base, ...o });

describe('externalAgentStatus', () => {
  it('unlocks every paid plan', () => {
    for (const plan of ['starter', 'pro', 'max']) {
      expect(externalAgentStatus(g({ plan }))).toBe('available');
      expect(canUseExternalAgents(g({ plan }))).toBe(true);
    }
  });

  it('locks the free plan with an upgrade reason', () => {
    expect(externalAgentStatus(g({ plan: 'free' }))).toBe('upgrade-required');
  });

  it('fails closed on an unknown or malformed plan', () => {
    // Mirrors the server's allowlist: a future tier id, a typo, or a corrupted
    // row must never open a paid path. Includes retired ids (proplus/ultra).
    expect(externalAgentStatus(g({ plan: 'enterprise' }))).toBe('upgrade-required');
    expect(externalAgentStatus(g({ plan: '' }))).toBe('upgrade-required');
    expect(externalAgentStatus(g({ plan: 'PRO' }))).toBe('upgrade-required');
    expect(externalAgentStatus(g({ plan: 'proplus' }))).toBe('upgrade-required');
    expect(externalAgentStatus(g({ plan: 'ultra' }))).toBe('upgrade-required');
  });

  it('reports signed-out before anything else', () => {
    expect(externalAgentStatus(g({ loggedIn: false, plan: null, online: false }))).toBe(
      'signed-out',
    );
  });

  it('reports offline before upgrade, so a paid user is never told to buy', () => {
    // The regression this locks in: an offline cold start leaves plan === null,
    // and treating that as "free" would upsell a user who already pays.
    expect(externalAgentStatus(g({ online: false, plan: null }))).toBe('offline');
    expect(externalAgentStatus(g({ online: false, plan: 'free' }))).toBe('offline');
  });

  it('reports plan-unknown when online but /v1/usage has not landed yet', () => {
    expect(externalAgentStatus(g({ plan: null }))).toBe('plan-unknown');
  });

  it('never upsells on a status it cannot verify', () => {
    for (const status of ['offline', 'plan-unknown'] as const) {
      expect(showsUpgradeCta(status)).toBe(false);
      // The exact wording differs per status (see 'copy never misleads'); what
      // must hold for both is that nothing is being sold.
      expect(EXTERNAL_AGENT_STATUS_TITLE[status]).toMatch(/plan/i);
      expect(showsRetryCta(status)).toBe(true);
    }
    expect(showsUpgradeCta('upgrade-required')).toBe(true);
  });
});

describe('externalAgentStatus: acpEnabled (server-config) decides', () => {
  it('acpEnabled true unlocks regardless of plan', () => {
    expect(externalAgentStatus(g({ acpEnabled: true, plan: 'free' }))).toBe('available');
    expect(externalAgentStatus(g({ acpEnabled: true, plan: null }))).toBe('available');
    expect(externalAgentStatus(g({ acpEnabled: true, plan: 'enterprise' }))).toBe('available');
  });

  it('acpEnabled false locks regardless of plan', () => {
    expect(externalAgentStatus(g({ acpEnabled: false, plan: 'max' }))).toBe('upgrade-required');
    expect(externalAgentStatus(g({ acpEnabled: false, plan: null }))).toBe('upgrade-required');
  });

  it('acpEnabled still yields to signed-out / offline', () => {
    expect(externalAgentStatus(g({ acpEnabled: true, loggedIn: false }))).toBe('signed-out');
    expect(externalAgentStatus(g({ acpEnabled: true, online: false }))).toBe('offline');
  });

  it('acpEnabled null + paid plan falls back to allowing', () => {
    expect(externalAgentStatus(g({ acpEnabled: null, plan: 'pro' }))).toBe('available');
  });

  it('acpEnabled null + unknown plan falls back to plan-unknown', () => {
    expect(externalAgentStatus(g({ acpEnabled: null, plan: null }))).toBe('plan-unknown');
  });
});

describe('refuseSendReason', () => {
  it('never blocks the Arcane agent, whatever the plan', () => {
    expect(refuseSendReason('arcane', g({ plan: 'free' }))).toBeNull();
    expect(refuseSendReason('arcane', g({ loggedIn: false, plan: null }))).toBeNull();
  });

  it('allows an entitled external send', () => {
    expect(refuseSendReason('claude', g())).toBeNull();
  });

  it('blocks the next send once a plan lapses mid-session', () => {
    expect(refuseSendReason('claude', g({ plan: 'free' }))).toBe(
      'Claude Code is available on paid plans.',
    );
  });
});

describe('copy never misleads', () => {
  it('offers a retry, not a purchase, for states a purchase cannot fix', () => {
    expect(showsRetryCta('offline')).toBe(true);
    expect(showsRetryCta('plan-unknown')).toBe(true);
    expect(showsRetryCta('upgrade-required')).toBe(false);
    expect(showsUpgradeCta('plan-unknown')).toBe(false);
  });

  it('never says "upgrade" on a status we could not verify', () => {
    for (const status of ['signed-out', 'offline', 'plan-unknown'] as const) {
      expect(EXTERNAL_AGENT_STATUS_TITLE[status].toLowerCase()).not.toContain('upgrade');
      expect(EXTERNAL_AGENT_STATUS_TITLE[status].toLowerCase()).not.toContain('paid plan');
    }
  });

  it('distinguishes "offline" from "plan not confirmed yet"', () => {
    // A cold start with a live network passes through plan-unknown while
    // /v1/usage is in flight; telling that user they are offline is a lie.
    expect(EXTERNAL_AGENT_STATUS_TITLE['plan-unknown']).not.toBe(
      EXTERNAL_AGENT_STATUS_TITLE.offline,
    );
  });

  it('has copy for every status, including the available one', () => {
    const statuses: ExternalAgentStatus[] = [
      'available',
      'signed-out',
      'offline',
      'plan-unknown',
      'upgrade-required',
    ];
    for (const s of statuses) {
      expect(EXTERNAL_AGENT_STATUS_TITLE[s]).toBeDefined();
      expect(EXTERNAL_AGENT_STATUS_LABEL[s]).toBeDefined();
    }
  });
});
