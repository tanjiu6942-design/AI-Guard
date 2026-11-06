import { describe, it, expect } from 'vitest';
import { classify, describeBlocker, checkNetworkReady, PROBES } from '../desktop/preflight.mjs';

/**
 * 回归: WFP 残留锁定会让 preflight 误判「无网络」, 从而永久无法启动。
 *
 * 现场(2026-11-06): 内核被杀后 WFP 4 条规则仍生效(除内核外全部 BLOCK)。
 * 用户重开软件 -> ensureNetworkReady() 三个端点全部 unreachable
 * -> 判 NO_NETWORK 拒绝启动 -> 但解除锁定偏偏只能在内核/worker 活着时做。
 * 于是「要解锁必须先启动, 要启动必须能出网, 要出网必须先解锁」——
 * 用户被彻底锁死, 最后只能还原系统。
 *
 * 所以: 当本机已知被 AI Guard 自己锁住时, 这条前置门必须让路 ——
 * 它防范的是"外部网络没准备好", 不是"我们自己的规则把网掐了"。
 */

const unreachable = (name) => ({ name, verdict: 'unreachable', error: 'ECONNREFUSED' });

describe('残留锁定下前置门必须放行', () => {
  it('三个端点全部不可达 + 已知本机自锁 = 放行(否则形成解锁死锁)', () => {
    const results = PROBES.map((p) => unreachable(p.name));
    const r = classify(results, { selfLocked: true });
    expect(r.ok).toBe(true);
    expect(r.code).toBeNull();
  });

  it('三个端点全部不可达 + 未自锁 = 仍然拒绝(原有行为不变)', () => {
    const results = PROBES.map((p) => unreachable(p.name));
    const r = classify(results);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_NETWORK');
  });

  it('自锁时即便被判定为门户也不拦 —— 门户判定依赖出网, 断网时不可信', () => {
    const results = PROBES.map((p) => ({ name: p.name, verdict: 'portal', location: 'http://x/y' }));
    const r = classify(results, { selfLocked: true });
    expect(r.ok).toBe(true);
  });

  it('未自锁时门户照旧拦截', () => {
    const results = PROBES.map((p) => ({ name: p.name, verdict: 'portal', location: 'http://x/y' }));
    const r = classify(results, { selfLocked: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CAPTIVE_PORTAL');
  });

  it('ensureNetworkReady 在自锁时不再抛错', async () => {
    const fetchFn = async () => { throw Object.assign(new Error('dead'), { name: 'TimeoutError' }); };
    const result = await checkNetworkReady({ fetchFn, selfLocked: true });
    expect(result.ok).toBe(true);
  });

  it('自锁放行时的提示语要说清原因, 不能静默', () => {
    const results = PROBES.map((p) => unreachable(p.name));
    const r = classify(results, { selfLocked: true });
    expect(r.selfLockedBypass).toBe(true);
    expect(describeBlocker(r)).toContain('本软件');
  });
});
