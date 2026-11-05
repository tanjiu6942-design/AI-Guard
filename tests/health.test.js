import { describe, it, expect } from 'vitest';
import { evaluateSystem, createHealthChecker, checkDnsPolicy } from '../desktop/health.mjs';
import { buildDns } from '../core/config/dns';
const system = () => ({ tunUp: true, dns: [{ iface: 'WLAN', servers: ['198.18.0.2', 'fdfe:dcba:9876::2'] }], route4: true,
  hasPublicIpv6: true, tunIpv6: true, route6: true, processes: [], otherTun: [] });
const route = (prefix, iface, routeMetric = 0, interfaceMetric = 0) => ({ prefix, iface, routeMetric, interfaceMetric });
const routedSystem = () => ({ ...system(), routes: [
  route('0.0.0.0/0', 'WLAN', 0, 1), route('0.0.0.0/1', 'Meta', 5, 10), route('128.0.0.0/1', 'Meta', 5, 10),
  route('::/0', 'WLAN', 0, 1), route('::/1', 'Meta', 5, 10), route('8000::/1', 'Meta', 5, 10),
] });
const routeResult = (snapshot, family) => evaluateSystem(snapshot).find(x => x.key === (family === 4 ? 'tun' : 'ipv6')).state;

describe('effective Internet route ownership', () => {
  it('accepts the physical IPv6 on-link prefix while retaining TUN Internet coverage', () => {
    const snapshot = routedSystem();
    snapshot.localNetworks = ['2408:8422:2f44:14aa::123/64', 'fe80::123%19/64'];
    snapshot.routes.push(route('2408:8422:2f44:14aa::/64', 'WLAN', 16, 35));
    expect(routeResult(snapshot, 6)).toBe('ok');
    snapshot.routes.push(route('2606:4700::/32', 'WLAN'));
    expect(routeResult(snapshot, 6)).toBe('fail');
  });
  it('prefers owned /1 routes over a cheaper physical default for both families', () => {
    expect(routeResult(routedSystem(), 4)).toBe('ok');
    expect(routeResult(routedSystem(), 6)).toBe('ok');
  });
  it.each([[4, '0.0.0.0/1'], [4, '128.0.0.0/1'], [6, '::/1'], [6, '8000::/1']])('rejects a cheaper competing IPv%s route %s', (family, prefix) => {
    const snapshot = routedSystem();
    snapshot.routes.push(route(prefix, 'Other', 1, 1));
    expect(routeResult(snapshot, family)).toBe('fail');
  });
  it.each([[4, '0.0.0.0/1'], [6, '8000::/1']])('reports equally preferred non-Meta IPv%s coverage as unknown', (family, prefix) => {
    // metric 完全并列(10+5 vs 5+10)时, 无法确定实际走哪条:
    // 判 fail 会把"工作正常的 TUN"误报成接管失效(实测因此反复整机断流),
    // 判 ok 又可能在真泄漏时说没事。所以如实 unknown。
    const snapshot = routedSystem();
    snapshot.routes.push(route(prefix, 'Other', 10, 5));
    expect(routeResult(snapshot, family)).toBe('unknown');
  });
  it('includes interface metric when comparing matching routes', () => {
    const snapshot = routedSystem();
    snapshot.routes[1] = route('0.0.0.0/1', 'Meta', 1, 50);
    snapshot.routes.push(route('0.0.0.0/1', 'Other', 20, 1));
    expect(routeResult(snapshot, 4)).toBe('fail');
  });
  it('accepts a less preferred competitor without losing owned coverage', () => {
    const snapshot = routedSystem();
    snapshot.routes.push(route('0.0.0.0/1', 'Other', 100, 1));
    expect(routeResult(snapshot, 4)).toBe('ok');
  });
  it('免改网卡模式 (takeoverDns: false) 下物理网卡保留原始 DNS 时 DNS 接管仍判 ok', () => {
    const snapshot = routedSystem();
    snapshot.dns = [{ iface: 'WLAN', servers: ['172.28.251.14', '114.114.114.114'] }];
    // 默认开启 takeoverDns 时判 fail
    const defaultRes = evaluateSystem(snapshot, 0).find(x => x.key === 'dns');
    expect(defaultRes.state).toBe('fail');
    // 关闭 takeoverDns 时判 ok (由 TUN dns-hijack 负责接管)
    const customRes = evaluateSystem(snapshot, 0, { takeoverDns: false }).find(x => x.key === 'dns');
    expect(customRes.state).toBe('ok');
    expect(customRes.detail).toContain('免改网卡');
  });

  it('uses a preferred Meta default for an uncovered half', () => {
    const snapshot = routedSystem();
    snapshot.routes = snapshot.routes.filter(r => r.prefix !== '128.0.0.0/1');
    snapshot.routes.push(route('0.0.0.0/0', 'Meta', 0, 0));
    expect(routeResult(snapshot, 4)).toBe('ok');
  });
  it('rejects an uncovered half when its effective default is physical', () => {
    const snapshot = routedSystem();
    snapshot.routes = snapshot.routes.filter(r => r.prefix !== '128.0.0.0/1');
    expect(routeResult(snapshot, 4)).toBe('fail');
  });
  it.each([[4, '8.8.8.0/24'], [6, '2606:4700::/32']])('rejects more specific public IPv%s subnet bypasses regardless of metric', (family, prefix) => {
    const snapshot = routedSystem();
    snapshot.routes.push(route(prefix, 'Other', 500, 500));
    expect(routeResult(snapshot, family)).toBe('fail');
  });
  it('rejects unverified public host routes alongside local subnet routes', () => {
    const snapshot = routedSystem();
    snapshot.routes.push(route('192.168.1.0/24', 'WLAN'), route('10.0.0.0/8', 'WLAN'),
      route('fe80::/64', 'WLAN'), route('fd00::/8', 'WLAN'), route('8.8.8.8/32', 'WLAN'), route('2606:4700::1111/128', 'WLAN'));
    expect(routeResult(snapshot, 4)).toBe('fail');
    expect(routeResult(snapshot, 6)).toBe('fail');
  });
});
describe('strict continuous health checks', () => {
  it('rejects domestic fallback DNS even when adapter DNS is taken over', () => {
    const dns = buildDns([], 'CN', true, 'sub.example.com');
    expect(checkDnsPolicy(dns, 'sub.example.com').state).toBe('ok');
    expect(checkDnsPolicy({ ...dns, nameserver: ['223.5.5.5'] }, 'sub.example.com')).toMatchObject({ state: 'fail', critical: true });
    expect(checkDnsPolicy({ ...dns, 'nameserver-policy': { 'geosite:cn': ['119.29.29.29'] } }, 'sub.example.com').state).toBe('fail');
    expect(checkDnsPolicy({ ...dns, fallback: ['system'] }, 'sub.example.com').state).toBe('fail');
    expect(checkDnsPolicy(undefined).state).toBe('unknown');
  });
  it('accepts verified dual-stack tunnel and DNS', () => expect(evaluateSystem(system()).every(x => x.state === 'ok')).toBe(true));
  it('does not claim DNS safe if adapter collection returned no data', () => {
    const items = evaluateSystem({ ...system(), dns: [] });
    expect(items.find(x => x.key === 'dns').state).toBe('unknown');
  });
  it('immediately marks an unprotected DNS server as unsafe', () => {
    const items = evaluateSystem({ ...system(), dns: [{ iface: 'WLAN', servers: ['192.168.1.1'] }] });
    expect(items.find(x => x.key === 'dns')).toMatchObject({ state: 'fail', critical: true });
  });
  it.each(['tunUp', 'route4', 'route6', 'tunIpv6'])('detects lost %s protection', field => {
    expect(evaluateSystem({ ...system(), [field]: false }).some(x => x.state === 'fail' && x.critical)).toBe(true);
  });
  it('does not compare SOCKS gateway address to actual egress', async () => {
    let ip = '203.0.113.10';
    const check = createHealthChecker({
      settings: { residential: { server: '192.0.2.4' } },
      fetchFn: async () => ({ ok: true, text: async () => `ip=${ip}\nloc=US\n` }),
    });
    expect((await check('exit'))[0].state).toBe('ok');
    ip = '203.0.113.11';
    expect((await check('exit'))[0]).toMatchObject({ state: 'fail', critical: true });
  });
  it('treats unavailable exit endpoints as unverified rather than healthy', async () => {
    const check = createHealthChecker({ settings: {}, fetchFn: async () => { throw Error('offline'); } });
    expect((await check('exit'))[0]).toMatchObject({ state: 'unknown', critical: false });
  });
  it('takes the local recovery snapshot after the long network probe completes', async () => {
    let current = system(), finishLong;
    const check = createHealthChecker({
      settings: { tunEnabled: true },
      systemSnapshot: async () => structuredClone(current),
      controller: async endpoint => endpoint === 'configs' ? { tun: { enable: true }, mode: 'rule' } : {
        rules: [{ proxy: 'REJECT', type: 'AND', payload: 'Network,udp DstPort,3478/5349/19302-19309' }],
      },
      fetchFn: async () => ({ ok: true, text: async () => 'ip=203.0.113.10\n' }),
      stun: async () => null,
      long: () => new Promise(resolve => { finishLong = resolve; }),
    });
    const full = check('full');
    current = { ...system(), route4: false };
    finishLong({ closed: false, aliveMs: 30000 });
    const results = await full;
    expect(results.find(x => x.key === 'tun')).toMatchObject({ state: 'fail', critical: true });
  });
});
