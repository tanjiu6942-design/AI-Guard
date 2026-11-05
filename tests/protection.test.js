import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProtectionMonitor } from '../desktop/protection.mjs';

const good = (key = 'exit') => ({ key, title: key, state: 'ok', detail: 'verified' });
const bad = (critical = true) => ({ ...good(), state: 'fail', detail: '出口改变', critical });
function fixture() {
  const events = [];
  const deps = {
    check: vi.fn(async () => [good()]),
    lock: vi.fn(async () => { events.push('lock'); }),
    unlock: vi.fn(async () => { events.push('unlock'); }),
    notify: vi.fn(),
  };
  return { monitor: new ProtectionMonitor(deps), deps, events };
}
afterEach(() => vi.useRealTimers());

describe('continuous protection', () => {
  it('only releases startup quarantine after a successful complete check', async () => {
    const { monitor, events } = fixture();
    await monitor.start();
    expect(monitor.snapshot().phase).toBe('healthy');
    expect(monitor.snapshot().fullCheckedAt).toBeTruthy();
    expect(events).toEqual(['unlock']);
    await monitor.shutdown();
  });
  it('keeps a persisted lock until an explicit manual recovery', async () => {
    const { monitor, deps } = fixture();
    await monitor.start({ locked: true, reason: 'previous failure' });
    expect(deps.check).not.toHaveBeenCalled();
    expect(deps.unlock).not.toHaveBeenCalled();
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });
  it('immediately blocks a confirmed leak and never automatically recovers', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    deps.check.mockResolvedValue([bad()]);
    await monitor.tick('local');
    expect(monitor.snapshot().phase).toBe('locked');
    expect(deps.lock).toHaveBeenCalledTimes(1);
    deps.check.mockResolvedValue([good()]);
    await monitor.tick('full');
    expect(deps.unlock).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });
  it('rechecks a transient failure before blocking', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    deps.check.mockResolvedValue([bad(false)]);
    await monitor.tick('exit');
    expect(monitor.snapshot().phase).toBe('suspect');
    expect(deps.lock).not.toHaveBeenCalled();
    await monitor.tick('exit');
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });
  it('clears a transient suspicion when the next sample succeeds', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    deps.check.mockResolvedValueOnce([bad(false)]).mockResolvedValueOnce([good()]);
    await monitor.tick('exit');
    await monitor.tick('exit');
    expect(monitor.snapshot().phase).toBe('healthy');
    expect(deps.lock).not.toHaveBeenCalled();
    await monitor.shutdown();
  });
  it('开启 autoReconnect 时在锁定后自动复检并恢复正常', async () => {
    let now = 1000;
    const timers = [];
    const deps = {
      check: vi.fn(async () => [good()]),
      lock: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
      notify: vi.fn(),
      now: () => now,
      schedule: (fn, ms) => {
        const item = { fn, due: now + ms };
        timers.push(item);
        return item;
      },
      cancel: (item) => {
        const i = timers.indexOf(item);
        if (i >= 0) timers.splice(i, 1);
      },
      autoReconnect: true,
    };
    const monitor = new ProtectionMonitor(deps);
    await monitor.start({ locked: true, reason: 'test' });
    expect(monitor.snapshot().phase).toBe('locked');

    // 触发定时器
    now += 15000;
    const due = timers.filter(t => t.due <= now);
    for (const t of due) await t.fn();
    await monitor.resumePromise;

    expect(monitor.snapshot().phase).toBe('healthy');
    expect(deps.unlock).toHaveBeenCalled();
    await monitor.shutdown();
  });

  it('does not treat collection errors as healthy', async () => {
    const { monitor, deps } = fixture();
    deps.check.mockRejectedValue(Error('permission denied'));
    await monitor.start();
    expect(monitor.snapshot().phase).toBe('locked');
    expect(deps.unlock).not.toHaveBeenCalled();
    await monitor.shutdown();
  });
  it('shows a blocking failure rather than claiming the machine is locked', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    deps.lock.mockRejectedValue(Error('WFP denied'));
    await monitor.trip('leak');
    expect(monitor.snapshot().phase).toBe('lock_failed');
    expect(monitor.snapshot().error).toContain('WFP denied');
    await monitor.shutdown();
  });
  it('keeps the lock if a manual full recheck is not entirely ok', async () => {
    const { monitor, deps } = fixture();
    await monitor.start({ locked: true });
    deps.check.mockResolvedValue([{ ...good(), state: 'unknown' }]);
    await monitor.resume();
    expect(monitor.snapshot().phase).toBe('locked');
    expect(deps.unlock).not.toHaveBeenCalled();
    await monitor.shutdown();
  });
  it('only a successful manual full recheck unlocks', async () => {
    const { monitor, deps, events } = fixture();
    await monitor.start({ locked: true });
    await monitor.resume();
    expect(deps.check).toHaveBeenCalledWith('full');
    expect(events).toEqual(['unlock']);
    expect(monitor.snapshot().phase).toBe('healthy');
    await monitor.shutdown();
  });
  it('prevents an old successful full check from unlocking after a new leak', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    let finish;
    deps.check.mockImplementation(kind => kind === 'full' ? new Promise(r => { finish = r; }) : Promise.resolve([bad()]));
    const pending = monitor.tick('full');
    await Promise.resolve();
    await monitor.tick('local');
    finish([good()]);
    await pending;
    expect(monitor.snapshot().phase).toBe('locked');
    expect(deps.unlock).toHaveBeenCalledTimes(1);
    await monitor.shutdown();
  });
  it('keeps local checks running while a full network check is in flight', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    let finish;
    deps.check.mockImplementation(kind => kind === 'full' ? new Promise(r => { finish = r; }) : Promise.resolve([good('dns')]));
    const pending = monitor.tick('full');
    await Promise.resolve();
    await monitor.tick('local');
    expect(monitor.snapshot().items.some(x => x.key === 'dns')).toBe(true);
    finish([good()]);
    await pending;
    await monitor.shutdown();
  });
  it('deduplicates concurrent network checks', async () => {
    const { monitor, deps } = fixture();
    await monitor.start();
    let finish;
    deps.check.mockImplementation(() => new Promise(r => { finish = r; }));
    const a = monitor.tick('full');
    const b = monitor.tick('exit');
    await Promise.resolve();
    expect(deps.check).toHaveBeenCalledTimes(2);
    finish([good()]);
    await Promise.all([a, b]);
    await monitor.shutdown();
  });
  it('periodically checks without any renderer status polling', async () => {
    vi.useFakeTimers();
    const { monitor, deps } = fixture();
    await monitor.start();
    await vi.advanceTimersByTimeAsync(16000);
    expect(deps.check.mock.calls.some(([kind]) => kind === 'local')).toBe(true);
    expect(deps.check.mock.calls.some(([kind]) => kind === 'exit')).toBe(true);
    await monitor.shutdown();
    const count = deps.check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70000);
    expect(deps.check).toHaveBeenCalledTimes(count);
  });
  it('a hung check expires into an abnormal result', async () => {
    vi.useFakeTimers();
    const { monitor, deps } = fixture();
    deps.check.mockImplementation(() => new Promise(() => {}));
    const start = monitor.start();
    await vi.advanceTimersByTimeAsync(46000);
    await start;
    expect(monitor.snapshot().phase).toBe('locked');
    expect(deps.unlock).not.toHaveBeenCalled();
    await monitor.shutdown();
  });
  it('serializes a late unlock with a newer emergency lock', async () => {
    const { monitor, deps } = fixture();
    let installed = true, finishUnlock;
    deps.unlock.mockImplementation(() => new Promise(resolve => { finishUnlock = () => { installed=false; resolve(); }; }));
    deps.lock.mockImplementation(async () => { installed=true; });
    await monitor.start({ locked:true });
    const resume=monitor.resume();
    for(let i=0; i<12 && !finishUnlock; i++) await Promise.resolve();
    const trip=monitor.trip('new leak');
    finishUnlock();
    await Promise.all([resume,trip]);
    expect(installed).toBe(true);
    expect(monitor.snapshot().phase).toBe('locked');
    await monitor.shutdown();
  });
});

 it('retains unresolved exit uncertainty across successful local samples', async () => {
   const { monitor, deps } = fixture();
   await monitor.start();
   deps.check.mockResolvedValueOnce([{ ...good(), state: 'unknown' }]);
   await monitor.tick('exit');
   deps.check.mockResolvedValueOnce([good('tun')]);
   await monitor.tick('local');
   expect(monitor.snapshot().phase).toBe('suspect');
   await monitor.shutdown();
 });
 it('never automatically releases after an inconclusive manual recheck', async () => {
   vi.useFakeTimers();
   const { monitor, deps } = fixture();
   await monitor.start({ locked: true });
   deps.check.mockResolvedValue([{ ...good(), state: 'unknown' }]);
   await monitor.resume();
   deps.check.mockResolvedValue([good()]);
   await vi.advanceTimersByTimeAsync(120000);
   expect(monitor.snapshot().phase).toBe('locked');
   expect(deps.unlock).not.toHaveBeenCalled();
   await monitor.resume();
   expect(monitor.snapshot().phase).toBe('healthy');
   await monitor.shutdown();
 });
