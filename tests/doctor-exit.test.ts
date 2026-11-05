import { describe, it, expect } from 'vitest';
import { checkExitConsistency, DEFAULT_TARGETS } from '../core/doctor/exit-consistency';

/** 按 host 关键字返回 IP; cloudflare 域名返回 trace 格式, 其它返回裸 IP */
function mockFetch(map: Record<string, string>) {
  return async (url: string) => {
    for (const [host, ip] of Object.entries(map)) {
      if (url.includes(host)) {
        return {
          ok: true,
          text: async () => `fl=abc\nh=${host}\nip=${ip}\nts=1\nloc=US\n`,
          json: async () => ({ ip }),
        } as unknown as Response;
      }
    }
    throw new Error('未匹配: ' + url);
  };
}

const allSame = (ip: string) =>
  mockFetch({
    'www.cloudflare.com': ip,
    'cloudflare-dns.com': ip,
    'challenges.cloudflare.com': ip,
  });

describe('出口一致性', () => {
  it('默认目标不含 AI 账号域名（用户要求不触碰线上账号环境）', () => {
    const hosts = DEFAULT_TARGETS.map((t) => t.host);
    expect(hosts).not.toContain('claude.ai');
    expect(hosts).not.toContain('chatgpt.com');
    expect(hosts).not.toContain('ws.chatgpt.com');
  });

  it('全部一致时通过', async () => {
    const r = await checkExitConsistency(allSame('1.1.1.1'), '1.1.1.1');
    expect(r.state).toBe('ok');
  });

  it('Cloudflare 走错出口时失败（核心回归）', async () => {
    const f = mockFetch({
      'www.cloudflare.com': '1.1.1.1',
      'cloudflare-dns.com': '1.1.1.1',
      'challenges.cloudflare.com': '9.9.9.9',
    });
    const r = await checkExitConsistency(f, '1.1.1.1');
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('9.9.9.9');
  });

  it('出口与预期不符时失败', async () => {
    const r = await checkExitConsistency(allSame('2.2.2.2'), '1.1.1.1');
    expect(r.state).toBe('fail');
  });

  it('部分请求失败时降级为 warn 而非误判通过', async () => {
    const f = async (url: string) => {
      if (url.includes('www.cloudflare.com')) {
        return { ok: true, text: async () => 'ip=1.1.1.1\n' } as unknown as Response;
      }
      throw new Error('网络错误');
    };
    const r = await checkExitConsistency(f, '1.1.1.1');
    expect(r.state).toBe('warn');
  });

  it('全部失败时返回 unknown', async () => {
    const f = async () => { throw new Error('全挂'); };
    const r = await checkExitConsistency(f, '1.1.1.1');
    expect(r.state).toBe('unknown');
  });

  it('支持自定义目标列表', async () => {
    const f = mockFetch({ 'example.com': '3.3.3.3' });
    const r = await checkExitConsistency(f, '3.3.3.3', [
      { host: 'example.com', label: 'example', path: '/cdn-cgi/trace' },
    ]);
    expect(r.state).toBe('ok');
    expect(r.detail).toContain('3.3.3.3');
  });
});
