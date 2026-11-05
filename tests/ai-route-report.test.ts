import { describe, it, expect } from 'vitest';
import { runAiRouteChecks, type ControllerGet } from '../core/doctor/ai-route-report';
import type { CheckResult, FetchFn } from '../core/doctor/types';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';
const AI_GROUP = 'AI Guard 专用';
const RESIDENTIAL = 'AI Guard · 独享 IP';
const BLOCK = 'AI Guard · 未就绪(阻断)';

/** 返回固定 trace 文本的假 fetch: cloudflare 与 claude.ai 都返回同一个出口 IP */
function traceFetch(ip: string | null = IP): FetchFn {
  return async () => {
    const body = ip === null ? 'fl=1\nts=1\n' : `fl=1\nip=${ip}\nts=1\n`;
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  };
}

/** 按路径分发的假控制接口 */
function makeController(data: {
  group?: unknown;
  guard?: unknown;
  rules?: unknown;
  connections?: unknown;
}): ControllerGet {
  return async (path: string) => {
    if (path.startsWith('/proxies/')) {
      if (!('group' in data)) throw new Error('no group');
      return data.group;
    }
    if (path === '/providers/proxies/guard-block') {
      if (!('guard' in data)) throw new Error('no guard');
      return data.guard;
    }
    if (path === '/rules') {
      if (!('rules' in data)) throw new Error('no rules');
      return data.rules;
    }
    if (path === '/connections') {
      if (!('connections' in data)) throw new Error('no connections');
      return data.connections;
    }
    throw new Error('unexpected path ' + path);
  };
}

/** 读不到任何东西的控制接口(内核没跑) */
const brokenController: ControllerGet = async () => {
  throw new Error('ECONNREFUSED');
};

/** 组类型是 Fallback 且带阻断节点 —— 断网保护应当 ok */
const goodGroup = { type: 'Fallback', all: [RESIDENTIAL, BLOCK], now: RESIDENTIAL };
const goodGuard = { proxies: [{ name: BLOCK }] };

/** 规则齐备: 三个进程名 + 两个域名都指向 AI Guard 专用 */
const fullRules = {
  rules: [
    { type: 'ProcessName', payload: 'claude.exe', proxy: AI_GROUP },
    { type: 'ProcessName', payload: 'Claude.exe', proxy: AI_GROUP },
    { type: 'ProcessName', payload: 'Claude Helper', proxy: AI_GROUP },
    { type: 'DomainSuffix', payload: 'claude.ai', proxy: AI_GROUP },
    { type: 'DomainSuffix', payload: 'anthropic.com', proxy: AI_GROUP },
  ],
};

function byKey(items: CheckResult[], key: string): CheckResult {
  const it = items.find((i) => i.key === key);
  if (!it) throw new Error('missing check: ' + key);
  return it;
}

describe('runAiRouteChecks · 独享 IP', () => {
  it('出口 IP 等于预期 -> 独享 IP 项 ok', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: brokenController,
    });
    const item = byKey(items, 'exclusive');
    expect(item.state).toBe('ok');
    expect(item.detail).toContain(IP);
  });

  it('出口 IP 不等于预期 -> 独享 IP 项 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(OTHER_IP),
      expectedIp: IP,
      controllerGet: brokenController,
    });
    const item = byKey(items, 'exclusive');
    expect(item.state).toBe('fail');
    expect(item.detail).toContain(OTHER_IP);
  });

  it('expectedIp 是域名 -> 独享 IP 项 unknown(不拿域名和 IP 比)', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: 'proxy.example.com',
      controllerGet: brokenController,
    });
    expect(byKey(items, 'exclusive').state).toBe('unknown');
  });

  it('探测不到出口 IP -> 独享 IP 项 unknown', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(null),
      expectedIp: IP,
      controllerGet: brokenController,
    });
    expect(byKey(items, 'exclusive').state).toBe('unknown');
  });
});

describe('runAiRouteChecks · 断网保护', () => {
  it('控制接口全部读不到 -> 断网保护 unknown, 且不得出现 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: brokenController,
    });
    expect(byKey(items, 'killswitch').state).toBe('unknown');
    expect(items.some((i) => i.state === 'fail')).toBe(false);
  });

  it('完全不传 controllerGet -> 断网保护 unknown, 且不得出现 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
    });
    expect(byKey(items, 'killswitch').state).toBe('unknown');
    expect(items.some((i) => i.state === 'fail')).toBe(false);
  });

  it('组类型不是 Fallback -> 断网保护 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: { type: 'Selector', all: [RESIDENTIAL, BLOCK] },
        guard: goodGuard,
      }),
    });
    const item = byKey(items, 'killswitch');
    expect(item.state).toBe('fail');
    expect(item.detail).toContain('组类型');
  });

  it('组类型名字不是 Fallback -> 断网保护 fail, detail 含 Fallback', async () => {
    // core 会把实际读到的组类型原样写进 detail, 所以这里用一个含
    // "Fallback" 但不等于 "Fallback" 的类型名来断言 detail 指向了它。
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: { type: 'NotFallback', all: [RESIDENTIAL, BLOCK] },
        guard: goodGuard,
      }),
    });
    const item = byKey(items, 'killswitch');
    expect(item.state).toBe('fail');
    expect(item.detail).toContain('Fallback');
  });

  it('组类型大小写不对 -> 断网保护 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: { type: 'fallback', all: [RESIDENTIAL, BLOCK] },
        guard: goodGuard,
      }),
    });
    const item = byKey(items, 'killswitch');
    expect(item.state).toBe('fail');
    expect(item.detail).toMatch(/fallback/i);
  });

  it('组里有 Fallback 和阻断节点 -> 断网保护 ok', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({ group: goodGroup, guard: goodGuard }),
    });
    const item = byKey(items, 'killswitch');
    expect(item.state).toBe('ok');
    expect(item.detail).toContain('阻断');
  });

  it('组里没有阻断节点 -> 断网保护 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: { type: 'Fallback', all: [RESIDENTIAL] },
        guard: goodGuard,
      }),
    });
    expect(byKey(items, 'killswitch').state).toBe('fail');
  });
});

describe('runAiRouteChecks · Claude Code 线路', () => {
  it('不传 controllerGet -> Claude Code 线路 unknown, 且不得出现 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
    });
    expect(byKey(items, 'claude-code').state).toBe('unknown');
    expect(items.some((i) => i.state === 'fail')).toBe(false);
  });

  it('规则里缺少 claude.exe 的 ProcessName 规则 -> Claude Code 线路 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: goodGroup,
        guard: goodGuard,
        rules: {
          rules: fullRules.rules.filter((r) => r.payload !== 'claude.exe'),
        },
      }),
    });
    const item = byKey(items, 'claude-code');
    expect(item.state).toBe('fail');
    expect(item.detail).toContain('claude.exe');
  });

  it('规则齐备但运行时连接没走独享 IP -> Claude Code 线路 fail', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: goodGroup,
        guard: goodGuard,
        rules: fullRules,
        connections: {
          connections: [
            {
              metadata: { process: 'claude.exe', host: 'api.anthropic.com' },
              chains: [AI_GROUP],
            },
          ],
        },
      }),
    });
    const item = byKey(items, 'claude-code');
    expect(item.state).toBe('fail');
    expect(item.detail).toContain('未经过独享 IP');
  });

  it('规则齐备且运行时连接走了独享 IP -> Claude Code 线路 ok', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({
        group: goodGroup,
        guard: goodGuard,
        rules: fullRules,
        connections: {
          connections: [
            {
              metadata: { process: 'claude.exe', host: 'api.anthropic.com' },
              chains: [RESIDENTIAL, AI_GROUP],
            },
          ],
        },
      }),
    });
    const item = byKey(items, 'claude-code');
    expect(item.state).toBe('ok');
    expect(item.detail).toContain(RESIDENTIAL);
  });

  it('规则读不到 -> Claude Code 线路 unknown(不是 fail)', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({ group: goodGroup, guard: goodGuard }),
    });
    expect(byKey(items, 'claude-code').state).toBe('unknown');
  });
});

describe('runAiRouteChecks · Claude 看到的 IP 与整体形状', () => {
  it('Claude 侧看到预期 IP -> Claude 看到的 IP 项 ok', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: brokenController,
    });
    expect(byKey(items, 'claude-ip').state).toBe('ok');
  });

  it('Claude 侧与独立住宅出口相同，即使网关不同也通过', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(OTHER_IP),
      expectedIp: IP,
      controllerGet: brokenController,
    });
    expect(byKey(items, 'claude-ip').state).toBe('ok');
  });

  it('返回顺序固定为 独享 IP / 断网保护 / Claude Code 线路 / Claude 看到的 IP', async () => {
    const items = await runAiRouteChecks({
      fetchFn: traceFetch(IP),
      expectedIp: IP,
      controllerGet: makeController({ group: goodGroup, guard: goodGuard }),
    });
    expect(items.map((i) => i.key)).toEqual([
      'exclusive',
      'killswitch',
      'claude-code',
      'claude-ip',
    ]);
  });
});


describe('住宅网关和真实出口证据', () => {
  it('网关不作为独享出口预期，Claude使用实际住宅出口', async () => {
    const items = await runAiRouteChecks({ fetchFn: traceFetch(OTHER_IP), expectedIp: IP, expectedEgressIp: null });
    expect(byKey(items, 'exclusive').state).toBe('unknown');
    expect(byKey(items, 'claude-ip').state).toBe('ok');
    expect(byKey(items, 'claude-ip').detail).toContain(OTHER_IP);
  });

  it('Claude与独立Cloudflare出口不同则失败', async () => {
    const items = await runAiRouteChecks({ fetchFn: traceFetch(OTHER_IP), expectedIp: 'gateway.example.com', exitIp: IP });
    expect(byKey(items, 'claude-ip').state).toBe('fail');
  });

  it('住宅出口探测失败不能回退比较网关', async () => {
    const items = await runAiRouteChecks({ fetchFn: traceFetch(IP), expectedIp: IP, exitIp: null });
    expect(byKey(items, 'claude-ip').state).toBe('unknown');
  });

  it.each([undefined, {}, { connections: 'invalid' }])('连接快照不可读时不能当作零连接: %s', async (connections) => {
    const items = await runAiRouteChecks({ fetchFn: traceFetch(), expectedIp: IP,
      controllerGet: makeController({ rules: fullRules, ...(connections === undefined ? {} : { connections }) }) });
    expect(byKey(items, 'claude-code').state).toBe('unknown');
    expect(byKey(items, 'claude-code').detail).toContain('连接');
  });

  it('空的有效连接快照只证明规则就绪', async () => {
    const items = await runAiRouteChecks({ fetchFn: traceFetch(), expectedIp: IP,
      controllerGet: makeController({ rules: fullRules, connections: { connections: [] } }) });
    expect(byKey(items, 'claude-code').state).toBe('warn');
  });
});


it('显式预期真实出口覆盖旧网关值，但仍能检测出口变化', async () => {
  const items = await runAiRouteChecks({ fetchFn: traceFetch(IP), expectedIp: IP, expectedEgressIp: OTHER_IP });
  expect(byKey(items, 'exclusive').state).toBe('fail');
  expect(byKey(items, 'exclusive').detail).toContain(OTHER_IP);
});
