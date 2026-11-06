import { describe, it, expect } from 'vitest';
import { createHealthChecker } from '../desktop/health.mjs';

/**
 * 漏洞: 实时保护的「出口一致性」只比较**端点之间是否一致**,
 * 从不校验这个出口是否是你配置的住宅 IP。
 *
 * 两条独立缺陷:
 *
 * 1. baseline 是内存变量(desktop/health.mjs:234), 进程重启即归零。
 *    -> 重启后第一个观察到的 IP 会被当作"正确基线", 哪怕它是机场 IP。
 *
 * 2. 完全没有 expectedIp 概念。
 *    core/doctor/exit-consistency.ts 里明明有 expectedIp 校验(CLI 体检用),
 *    但 desktop/health.mjs 这个实时保护路径一次都没引用它(实测 grep 结果为 0)。
 *
 * 后果: 住宅 SOCKS5 挂掉、流量回落到机场节点时, 三个探针会**一致地**
 * 报告机场 IP, 于是判 `ok: 出口保持一致`。用户界面显示全绿,
 * 而他此刻正以机场 IP 访问 Claude —— 正是本工具要防的封号场景。
 */

const trace = (ip, loc = 'US') => `ip=${ip}\nloc=${loc}\nts=1\n`;

function fixture({ ips, expectedIp } = {}) {
  const calls = [];
  let i = 0;
  const fetchFn = async (url) => {
    calls.push(url);
    // 三个端点各取一个 IP; ips 可以是固定值也可以按调用序号轮转
    const ip = Array.isArray(ips) ? ips[Math.min(i++, ips.length - 1)] : ips;
    return { ok: true, status: 200, text: async () => trace(ip), headers: { get: () => null } };
  };
  const check = createHealthChecker({
    settings: {
      realtimeProtection: true,
      tunEnabled: true,
      takeoverDns: true,
      airportUrl: 'https://sub.example.com/link/x',
      residential: { server: expectedIp ?? '203.0.113.7', port: 1, username: 'u', password: 'p' },
    },
    controller: async () => ({}),
    probePort: 7890,
    corePid: 1,
    fetchFn,
    long: async () => ({ ok: true }),
    stun: async () => ({ ip: null }),
    inStartupGrace: () => false,
  });
  return { check, calls };
}

describe('实时保护必须校验出口是否为住宅 IP', () => {
  it('三个探针一致地返回机场 IP 时, 必须判 fail 而不是 ok', async () => {
    const { check } = fixture({ ips: '45.1.2.3', expectedIp: '203.0.113.7' });
    const items = await check('exit');
    const exit = items.find((x) => x.key === 'exit');
    expect(exit.state).not.toBe('ok');
    expect(exit.critical).toBe(true);
    expect(exit.detail).toMatch(/217\.77\.19\.234|预期|住宅/);
  });

  it('出口等于住宅 IP 时判 ok', async () => {
    const { check } = fixture({ ips: '203.0.113.7', expectedIp: '203.0.113.7' });
    const items = await check('exit');
    const exit = items.find((x) => x.key === 'exit');
    expect(exit.state).toBe('ok');
  });

  it('三个端点互相不一致时仍然 fail(原有契约不变)', async () => {
    const { check } = fixture({ ips: ['1.1.1.1', '2.2.2.2', '3.3.3.3'], expectedIp: '203.0.113.7' });
    const items = await check('exit');
    const exit = items.find((x) => x.key === 'exit');
    expect(exit.state).toBe('fail');
  });
});
