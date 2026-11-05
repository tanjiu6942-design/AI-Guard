import { describe, it, expect } from 'vitest';
import {
  probeTraceIp,
  checkExclusiveIp,
  checkKillSwitch,
  checkClaudeCodeRoute,
  checkClaudeIp,
  CLAUDE_CODE_PROCESSES,
  CLAUDE_CODE_DOMAINS,
} from '../core/doctor/ai-route';
import { G_AI } from '../core/config/constants';
import { RESIDENTIAL_PROXY_NAME } from '../core/config/groups';

const IP = '203.0.113.7';

/** 返回固定 trace 文本的假 fetch */
function traceFetch(body: string, ok = true, status = 200) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return { ok, status, text: async () => body } as unknown as Response;
  };
  return { fn, calls };
}

/** 规则齐备的最小规则集 */
function fullRules() {
  const rules = [
    ...CLAUDE_CODE_PROCESSES.map((p) => ({ type: 'ProcessName', payload: p, proxy: G_AI })),
    ...CLAUDE_CODE_DOMAINS.map((d) => ({ type: 'DomainSuffix', payload: d, proxy: G_AI })),
  ];
  return rules;
}

describe('probeTraceIp', () => {
  it('解析出 ip= 行', async () => {
    const { fn } = traceFetch('fl=1\nh=x\nip=203.0.113.7\nts=1\n');
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBe(IP);
  });

  it('ip= 行带空格时 trim', async () => {
    const { fn } = traceFetch('ip=  203.0.113.7  \n');
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBe('203.0.113.7');
  });

  it('文本里没有 ip= 时返回 null', async () => {
    const { fn } = traceFetch('fl=1\nts=1\n');
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBeNull();
  });

  it('请求抛错时返回 null 而不抛出', async () => {
    const fn = async () => {
      throw new Error('boom');
    };
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBeNull();
  });

  it('HTTP 非 2xx 时返回 null', async () => {
    const { fn } = traceFetch('ip=1.2.3.4', false, 502);
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBeNull();
  });
});

describe('独享 IP', () => {
  it('出口等于预期 IP 时通过', () => {
    const r = checkExclusiveIp(IP, IP);
    expect(r.state).toBe('ok');
    expect(r.key).toBe('exclusive');
    expect(r.title).toBe('独享 IP');
    expect(r.detail).toBe(`出口即你的独享 IP ${IP}`);
  });

  it('出口与预期不符时失败', () => {
    const r = checkExclusiveIp('198.51.100.9', IP);
    expect(r.state).toBe('fail');
    expect(r.detail).toBe(`出口是 198.51.100.9，不是你的独享 IP ${IP}`);
  });

  it('拿不到出口 IP 时为 unknown', () => {
    const r = checkExclusiveIp(null, IP);
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('未能获取出口 IP');
  });

  it('未配置住宅 IP 时为 unknown', () => {
    const r = checkExclusiveIp(IP, '');
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('未配置住宅 IP，无法核对独享出口');
  });

  it('预期值是域名（供应商只给域名）时不判定失败，且不与出口 IP 硬比', () => {
    const r = checkExclusiveIp('198.51.100.9', 'proxy.example.com');
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('未配置住宅 IP，无法核对独享出口');
  });
});

describe('断网保护', () => {
  const guard = ['AI Guard · 未就绪(阻断)'];

  it('Fallback 组含阻断节点时通过', () => {
    const r = checkKillSwitch({
      groupType: 'Fallback',
      groupMembers: ['AI Guard · 独享 IP', ...guard],
      guardNodeNames: guard,
    });
    expect(r.state).toBe('ok');
    expect(r.key).toBe('killswitch');
    expect(r.detail).toBe('住宅 IP 失效时流量会被阻断，不会回落直连');
  });

  it('组类型不是 Fallback 时失败', () => {
    const r = checkKillSwitch({
      groupType: 'Selector',
      groupMembers: ['AI Guard · 独享 IP'],
      guardNodeNames: guard,
    });
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('组类型为 Selector');
  });

  it('缺少阻断节点时失败（空组会被填成 COMPATIBLE 即直连）', () => {
    const r = checkKillSwitch({
      groupType: 'Fallback',
      groupMembers: ['AI Guard · 独享 IP'],
      guardNodeNames: [],
    });
    expect(r.state).toBe('fail');
    expect(r.detail).toBe('内核缺少阻断节点，独享 IP 失效时流量会直连泄漏');
  });

  it('读不到组状态时为 unknown', () => {
    const r = checkKillSwitch({ groupType: null, groupMembers: null, guardNodeNames: guard });
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('无法读取内核代理组状态');
  });

  it('读不到组成员时为 unknown', () => {
    const r = checkKillSwitch({ groupType: 'Fallback', groupMembers: null, guardNodeNames: guard });
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('无法读取内核代理组成员');
  });

  it('阻断节点未加入组时失败', () => {
    const r = checkKillSwitch({
      groupType: 'Fallback',
      groupMembers: ['AI Guard · 独享 IP'],
      guardNodeNames: guard,
    });
    expect(r.state).toBe('fail');
    expect(r.detail).toBe('阻断节点未加入 AI Guard 专用 组');
  });
});

describe('Claude Code 线路', () => {
  it('规则齐备且运行时链路经过独享 IP 时通过', () => {
    const r = checkClaudeCodeRoute({
      rules: fullRules(),
      connections: [
        {
          process: 'claude.exe',
          host: 'api.anthropic.com',
          chains: [RESIDENTIAL_PROXY_NAME, G_AI],
        },
      ],
    });
    expect(r.state).toBe('ok');
    expect(r.key).toBe('claude-code');
    expect(r.title).toBe('Claude Code 线路');
    expect(r.detail).toBe(
      `Claude Code 的规则与运行时链路都走 ${G_AI} → ${RESIDENTIAL_PROXY_NAME}`,
    );
  });

  it('缺少进程规则时失败并列出缺失项', () => {
    const rules = fullRules().filter((r) => r.payload !== 'claude.exe');
    const r = checkClaudeCodeRoute({ rules, connections: [] });
    expect(r.state).toBe('fail');
    expect(r.detail).toBe('缺少 Claude 线路规则：claude.exe');
  });

  it('缺少域名规则时失败并列出缺失项', () => {
    const rules = fullRules().filter((r) => r.payload !== 'anthropic.com');
    const r = checkClaudeCodeRoute({ rules, connections: [] });
    expect(r.state).toBe('fail');
    expect(r.detail).toBe('缺少 Claude 线路规则：DOMAIN anthropic.com');
  });

  it('规则指向别的代理组时视为缺失', () => {
    const rules = fullRules().map((r) => ({ ...r, proxy: '普通代理' }));
    const r = checkClaudeCodeRoute({ rules, connections: [] });
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('缺少 Claude 线路规则');
  });

  it('运行时 Claude 连接未经过独享 IP 时失败', () => {
    const r = checkClaudeCodeRoute({
      rules: fullRules(),
      connections: [
        { process: 'Claude.exe', host: 'claude.ai', chains: ['普通代理'] },
      ],
    });
    expect(r.state).toBe('fail');
    expect(r.detail).toBe('Claude Code 流量走了 普通代理，未经过独享 IP');
  });

  it('没有 Claude 活跃连接时警告并等待实际链路', () => {
    const r = checkClaudeCodeRoute({ rules: fullRules(), connections: [] });
    expect(r.state).toBe('warn');
    expect(r.detail).toContain('规则已就绪');
    expect(r.detail).toContain('等待');
  });

  it('按域名后缀识别 Claude 连接（不依赖进程名）', () => {
    const r = checkClaudeCodeRoute({
      rules: fullRules(),
      connections: [
        { host: 'api.anthropic.com', chains: ['普通代理'] },
      ],
    });
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('未经过独享 IP');
  });

  it('进程名匹配忽略大小写', () => {
    const r = checkClaudeCodeRoute({
      rules: fullRules(),
      connections: [
        { process: 'CLAUDE.EXE', chains: ['普通代理'] },
      ],
    });
    expect(r.state).toBe('fail');
  });

  it('非 Claude 的连接不参与判定', () => {
    const r = checkClaudeCodeRoute({
      rules: fullRules(),
      connections: [{ process: 'chrome.exe', host: 'example.com', chains: ['普通代理'] }],
    });
    expect(r.state).toBe('warn');
  });
});

describe('Claude 看到的 IP', () => {
  it('与独享 IP 一致时通过', async () => {
    const { fn } = traceFetch(`ip=${IP}\n`);
    const r = await checkClaudeIp(fn, IP);
    expect(r.state).toBe('ok');
    expect(r.key).toBe('claude-ip');
    expect(r.title).toBe('Claude 看到的 IP');
    expect(r.detail).toBe(`claude.ai 的 Cloudflare 边缘观察到 ${IP}，与住宅出口一致；未验证 Claude Code 后端 API`);
  });

  it('不一致时失败', async () => {
    const { fn } = traceFetch('ip=198.51.100.9\n');
    const r = await checkClaudeIp(fn, IP);
    expect(r.state).toBe('fail');
    expect(r.detail).toBe(`claude.ai 的 Cloudflare 边缘观察到 198.51.100.9，与住宅出口 ${IP} 不一致；未验证 Claude Code 后端 API`);
  });

  it('请求抛错时为 unknown 且带错误信息', async () => {
    const fn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await checkClaudeIp(fn, IP);
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('未能获取 Claude 侧出口信息：ECONNREFUSED');
  });

  it('HTTP 非 2xx 时为 unknown 并带状态码', async () => {
    const { fn } = traceFetch('ip=1.2.3.4', false, 403);
    const r = await checkClaudeIp(fn, IP);
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('Claude 侧探测返回 HTTP 403');
  });

  it('没有 ip= 时为 unknown', async () => {
    const { fn } = traceFetch('fl=1\n');
    const r = await checkClaudeIp(fn, IP);
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('Claude 侧未返回出口信息');
  });

  it('未配置住宅 IP 时为 unknown 且不发请求', async () => {
    const { fn, calls } = traceFetch(`ip=${IP}\n`);
    const r = await checkClaudeIp(fn, '');
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('未配置住宅 IP，无法核对 Claude 看到的出口');
    expect(calls.length).toBe(0);
  });

  it('预期值是域名时不判定失败且不发请求', async () => {
    const { fn, calls } = traceFetch('ip=198.51.100.9\n');
    const r = await checkClaudeIp(fn, 'proxy.example.com');
    expect(r.state).toBe('unknown');
    expect(r.detail).toBe('未配置住宅 IP，无法核对 Claude 看到的出口');
    expect(calls.length).toBe(0);
  });

  it('请求打到 claude.ai 的 trace 端点', async () => {
    const { fn, calls } = traceFetch(`ip=${IP}\n`);
    await checkClaudeIp(fn, IP);
    expect(calls[0]).toBe('https://claude.ai/cdn-cgi/trace');
  });
});


describe('trace 地址有效性', () => {
  it.each(['ip=999.1.2.3\n', 'ip=<html>blocked</html>\n', '<html>ip=203.0.113.7</html>'])('无效 trace 不能成为出口证据: %s', async (body) => {
    const { fn } = traceFetch(body);
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBeNull();
    expect((await checkClaudeIp(fn, IP)).state).toBe('unknown');
  });

  it('IPv6 是有效出口且不同写法按同一地址比较', async () => {
    const { fn } = traceFetch('ip=2001:db8::1\n');
    expect(await probeTraceIp(fn, 'https://x/cdn-cgi/trace')).toBe('2001:db8::1');
    expect((await checkClaudeIp(fn, '2001:0db8:0:0:0:0:0:1')).state).toBe('ok');
    expect(checkExclusiveIp('2001:db8::1', '2001:0db8:0:0:0:0:0:1').state).toBe('ok');
  });
});
