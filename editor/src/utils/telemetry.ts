// Telemetry stub. Currently a no-op interface.
// Wire to Sentry, PostHog, or a self-hosted endpoint when ready.

export interface TelemetryEvent {
  name: string;
  properties?: Record<string, string | number | boolean>;
}

export const telemetry = {
  track(_event: TelemetryEvent): void {
    // no-op
  },
  error(_err: unknown, _context?: Record<string, unknown>): void {
    // no-op
  },
  identify(_userId: string, _traits?: Record<string, unknown>): void {
    // no-op
  },
};
