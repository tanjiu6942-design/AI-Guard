import { describe, it, expect } from 'vitest';
import { evaluateSystem } from '../desktop/health.mjs';

const route = (prefix, iface, routeMetric, interfaceMetric) => ({ prefix, iface, routeMetric, interfaceMetric });
const stateOf = (items, key) => items.find(x => x.key === key)?.state;

// 复刻用户机器的真实路由形态:
//   0.0.0.0/0  Meta  RouteMetric=0  InterfaceMetric=(取不到)
//   0.0.0.0/0  WLAN  RouteMetric=0  InterfaceMetric=35
//   ::/0       Meta  RouteMetric=0  InterfaceMetric=(取不到)
//   ::/0       WLAN  RouteMetric=16 InterfaceMetric=35
const realShape = () => ({
  tunUp: true,
  dns: [{ iface: 'WLAN', servers: ['198.18.0.2', 'fdfe:dcba:9876::2'] }],
  routes: [
    route('0.0.0.0/0', 'Meta', 0, undefined),
    route('0.0.0.0/0', 'WLAN', 0, 35),
    route('::/0', 'Meta', 0, undefined),
    route('::/0', 'WLAN', 16, 35),
  ],
  hasPublicIpv6: true, tunIpv6: true,
  processes: [], otherTun: [],
});

describe('InterfaceMetric 取不到时不得误判接管失效', () => {
  it('Meta 的 InterfaceMetric 缺失时 TUN 仍判 ok', () => {
    // 实测根因: PowerShell 的 Get-NetIPInterface 查不到 Meta 的 InterfaceMetric,
    // 返回 $null。旧逻辑 typeof !== 'number' 直接 return false,
    // 于是 tun/ipv6 永远报"接管失效", 连续两轮触发整机断流。
    expect(stateOf(evaluateSystem(realShape(), 1, { gracePeriod: false }), 'tun')).toBe('ok');
  });

  it('Meta 的 InterfaceMetric 缺失时 IPv6 仍判 ok', () => {
    expect(stateOf(evaluateSystem(realShape(), 1, { gracePeriod: false }), 'ipv6')).toBe('ok');
  });

  it('RouteMetric 缺失才当作数据不可信', () => {
    const snapshot = realShape();
    snapshot.routes[0] = route('0.0.0.0/0', 'Meta', undefined, 0);
    // Meta 路由数据不可用, 该网段等于没有可信的 Meta 路由
    expect(stateOf(evaluateSystem(snapshot, 1, { gracePeriod: false }), 'tun')).not.toBe('ok');
  });

  it('物理网卡 metric 明显更优时仍判 fail(真实泄漏不能放过)', () => {
    const snapshot = realShape();
    snapshot.routes[0] = route('0.0.0.0/0', 'Meta', 100, 0);
    snapshot.routes[1] = route('0.0.0.0/0', 'WLAN', 0, 35);
    expect(stateOf(evaluateSystem(snapshot, 1, { gracePeriod: false }), 'tun')).toBe('fail');
  });
});
