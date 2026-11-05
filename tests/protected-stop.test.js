import { it, expect, vi } from 'vitest';
import { stopProtectedSession } from '../desktop/protected-stop.mjs';

it('keeps the core and retries alive if system lock cannot be confirmed', async () => {
  const protection = { trip: vi.fn(async () => ({ phase: 'lock_failed' })),
    assertSystemLocked: vi.fn(async () => { throw Error('WFP unavailable'); }), shutdown: vi.fn(), release: vi.fn() };
  const session = { stop: vi.fn() };
  await expect(stopProtectedSession({ protection, session, preserve: true, reason: 'UI disconnected' })).rejects.toThrow('WFP unavailable');
  expect(protection.shutdown).not.toHaveBeenCalled();
  expect(session.stop).not.toHaveBeenCalled();
  expect(protection.release).not.toHaveBeenCalled();
});

it('confirms the persistent block before stopping the core on preserved exit', async () => {
  const calls = [];
  const protection = Object.fromEntries(['trip', 'assertSystemLocked', 'shutdown', 'release'].map(k => [k, async () => calls.push(k)]));
  await stopProtectedSession({ protection, session: { stop: async () => calls.push('stop') }, preserve: true });
  expect(calls).toEqual(['trip', 'assertSystemLocked', 'shutdown', 'stop']);
});

it('removes filters only after the core stops and DNS restoration completes on explicit release', async () => {
  const calls = [];
  const protection = { shutdown: async () => calls.push('shutdown'), release: async () => calls.push('unlock') };
  await expect(stopProtectedSession({ protection, session: { stop: async () => { throw Error('DNS restore failed'); } }, preserve: false })).rejects.toThrow('DNS restore failed');
  expect(calls).toEqual(['shutdown']);
  await stopProtectedSession({ protection, session: { stop: async () => calls.push('stop + restore DNS') }, preserve: false });
  expect(calls).toEqual(['shutdown', 'shutdown', 'stop + restore DNS', 'unlock']);
});
