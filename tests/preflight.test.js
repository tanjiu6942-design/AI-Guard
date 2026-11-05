import { describe, it, expect } from 'vitest';
import {
  PROBES,
  classify,
  probeOne,
  checkNetworkReady,
  pickPortalUrl,
  describeBlocker,
} from '../desktop/preflight.mjs';

// 模拟一次 HTTP 响应；只要 probeOne 用到的那三个成员。
const res = (status, body = '', location = null) => ({
  status,
  headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) },
  text: async () => body,
});

const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

/** 按 URL 返回预设响应，其余端点一律超时。 */
const fetchByUrl = (map) => async (url) => {
  const hit = map[url];
  if (!hit) throw timeoutError();
  return typeof hit === 'function' ? hit() : hit;
};

const urlOf = (name) => PROBES.find((p) => p.name === name).url;

const okMap = () => ({
  [urlOf('Windows NCSI')]: res(200, 'Microsoft Connect Test'),
  [urlOf('MIUI')]: res(204, ''),
  [urlOf('Baidu')]: res(200, 'User-agent: *'),
});

describe('captive portal 判定', () => {
  it('三个端点都正常时放行', () => {
    const r = classify([
      { name: 'a', verdict: 'ok' },
      { name: 'b', verdict: 'ok' },
      { name: 'c', verdict: 'ok' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.code).toBeNull();
  });

  it('任一端点被重定向到外部地址即判定需要认证，并取出门户 URL', () => {
    const r = classify([
      { name: 'a', verdict: 'ok' },
      { name: 'b', verdict: 'portal', status: 302, location: 'http://10.10.10.10/srun_portal?x=1' },
      { name: 'c', verdict: 'ok' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CAPTIVE_PORTAL');
    expect(r.portalUrl).toBe('http://10.10.10.10/srun_portal?x=1');
  });

  it('三个端点全部无响应才判定无网络', () => {
    const r = classify([
      { name: 'a', verdict: 'unreachable' },
      { name: 'b', verdict: 'unreachable' },
      { name: 'c', verdict: 'unreachable' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_NETWORK');
  });

  it('证据模棱两可时一律放行（误拦比漏拦更糟）', () => {
    const r = classify([
      { name: 'a', verdict: 'unreachable' },
      { name: 'b', verdict: 'ok' },
      { name: 'c', verdict: 'unexpected' },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe('单个端点探测', () => {
  it('区分「正常 204」与「200 但内容是登录页」', async () => {
    const probe = PROBES.find((p) => p.name === 'MIUI');
    const good = await probeOne(probe, { fetchFn: async () => res(204, '') });
    expect(good.verdict).toBe('ok');

    const portal = await probeOne(probe, {
      fetchFn: async () => res(200, '<html><form action=/login><input type=password></form></html>'),
    });
    expect(portal.verdict).toBe('portal');
  });

  it('把超时折算成 unreachable 而不是抛出去', async () => {
    const probe = PROBES[0];
    const r = await probeOne(probe, { fetchFn: async () => { throw timeoutError(); } });
    expect(r.verdict).toBe('unreachable');
    expect(r.error).toContain('超时');
  });

  it('重定向到探测端点自己不算门户地址', () => {
    const self = urlOf('MIUI');
    const results = [{ name: 'MIUI', verdict: 'portal', location: self }];
    expect(pickPortalUrl(results)).toBeNull();
  });
});

describe('checkNetworkReady', () => {
  it('全部正常时返回 ok', async () => {
    const r = await checkNetworkReady({ fetchFn: fetchByUrl(okMap()) });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(PROBES.length);
  });

  it('Windows 端点被门户改写时拦下并带出认证地址', async () => {
    const map = okMap();
    map[urlOf('Windows NCSI')] = res(302, '', 'http://portal.campus.edu.cn/sso/login');
    const r = await checkNetworkReady({ fetchFn: fetchByUrl(map) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CAPTIVE_PORTAL');
    expect(r.portalUrl).toBe('http://portal.campus.edu.cn/sso/login');
  });

  it('全部超时判定无网络', async () => {
    const r = await checkNetworkReady({ fetchFn: fetchByUrl({}) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_NETWORK');
  });
});

describe('给用户看的说明', () => {
  it('需要认证时带上认证地址与跳过开关', () => {
    const text = describeBlocker({ code: 'CAPTIVE_PORTAL', portalUrl: 'http://portal.campus.edu.cn/sso' });
    expect(text).toContain('网页认证');
    expect(text).toContain('http://portal.campus.edu.cn/sso');
    expect(text).toContain('AIGUARD_SKIP_PREFLIGHT');
  });

  it('无网络时说明去打不开的出口，而不是甩一句失败', () => {
    const text = describeBlocker({ code: 'NO_NETWORK' });
    expect(text).toContain('无响应');
    expect(text).toContain('AIGUARD_SKIP_PREFLIGHT');
  });
});
