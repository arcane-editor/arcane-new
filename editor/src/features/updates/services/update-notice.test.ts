import { describe, it, expect } from 'bun:test';
import { updateReadyMessage } from './update-notice';

describe('updateReadyMessage', () => {
  it('says the update is already installed on macOS', () => {
    const msg = updateReadyMessage({ version: '0.3.2', installed: true });
    expect(msg).toContain('0.3.2');
    expect(msg).toContain('installed');
  });

  it('warns that restarting still has work to do on Windows', () => {
    // Windows downloads at restart time rather than in the background, so the
    // copy must not promise an instant restart the way the macOS copy can.
    const msg = updateReadyMessage({ version: '0.3.2', installed: false });
    expect(msg).toContain('0.3.2');
    expect(msg).not.toContain('installed');
    expect(msg.toLowerCase()).toContain('download');
  });
});
