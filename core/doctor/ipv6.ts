import type { CheckResult } from './types.js';

/**
 * IPv6 防泄漏检测。
 *
 * 旧实现只靠 STUN 探测: 探不到就判通过。实测踩过坑 —— STUN 的 UDP
 * 可能被规则 REJECT 掉(那确实是好事), 但**系统层的 IPv6 默认路由
 * 仍指向物理网卡**时, 浏览器照样能用 IPv6 直连出去, 只探 STUN 看不出来。
 *
 * 所以改成"读配置 + 探结果"两层:
 *   第一层(权威): 物理网卡是否有公网 IPv6、TUN 是否配了 IPv6、
 *                 ::/0 默认路由指向谁。任何一项不满足都判 fail。
 *   第二层(佐证): STUN 能否探到真实 IPv6。
 *
 * 读配置需要平台命令, 由调用方注入 snapshot(), 保持 core/ 纯逻辑。
 */
export interface Ipv6Snapshot {
  /** 物理网卡(排除 TUN)上的公网 IPv6 地址 */
  physicalPublic: { iface: string; addr: string }[];
  /** TUN 网卡是否配置了 IPv6 地址 */
  tunHasIpv6: boolean;
  /** IPv6 默认路由(::/0)所指向的接口别名列表 */
  ipv6DefaultRoutes: string[];
  /** TUN 网卡别名, 用于判断默认路由是否落在隧道上 */
  tunAlias: string;
}

export type Ipv6SnapshotReader = () => Promise<Ipv6Snapshot>;

export async function checkIpv6(
  hasIpv6: boolean,
  probe: () => Promise<string | null> = async () => null,
  snapshot?: Ipv6SnapshotReader,
): Promise<CheckResult> {
  if (!hasIpv6) {
    return {
      key: 'ipv6',
      title: 'IPv6 防泄漏',
      state: 'ok',
      detail: '本机没有公网 IPv6, 不会从 IPv6 泄漏',
    };
  }

  // ── 第一层: 读系统配置 ──
  let snap: Ipv6Snapshot | null = null;
  if (snapshot) {
    try {
      snap = await snapshot();
    } catch (e) {
      if (process.env.AIGUARD_DEBUG) {
        console.error('[ipv6] 读取配置失败: ' + (e as Error).message);
      }
    }
  }

  if (snap) {
    const tunName = snap.tunAlias || 'Meta';

    // (a) TUN 没配 IPv6 → 所有 IPv6 流量都绕过隧道
    if (!snap.tunHasIpv6) {
      return {
        key: 'ipv6',
        title: 'IPv6 防泄漏',
        state: 'fail',
        detail: `本机有公网 IPv6 (${snap.physicalPublic.map((x) => x.addr).join('、')}) ` +
          `但 TUN 网卡没有 IPv6 地址, IPv6 流量完全绕过代理`,
      };
    }

    // (b) ::/0 默认路由不在 TUN 上 → 系统优先走物理网卡
    const viaTun = snap.ipv6DefaultRoutes.some((r) => r === tunName);
    const viaPhysical = snap.ipv6DefaultRoutes.filter((r) => r !== tunName);

    if (snap.ipv6DefaultRoutes.length > 0 && !viaTun) {
      return {
        key: 'ipv6',
        title: 'IPv6 防泄漏',
        state: 'fail',
        detail: `IPv6 默认路由指向 ${viaPhysical.join('、')} 而非 ${tunName}, ` +
          `IPv6 流量绕过隧道直接出去 (本机 IPv6: ${snap.physicalPublic.map((x) => x.addr).join('、')})`,
      };
    }
  }

  // ── 第二层: STUN 佐证 ──
  const ip = await probe();
  if (ip) {
    return {
      key: 'ipv6',
      title: 'IPv6 防泄漏',
      state: 'fail',
      detail: `网页可以通过 IPv6 看到 ${ip}, 说明 IPv6 未被接管`,
    };
  }

  const base = snap
    ? `IPv6 已被隧道接管 (TUN 有 IPv6 地址, ::/0 路由指向 ${snap.tunAlias || 'Meta'})`
    : 'IPv6 流量已被接管, 网页看不到你的 IPv6 地址';

  return {
    key: 'ipv6',
    title: 'IPv6 防泄漏',
    state: 'ok',
    detail: base,
  };
}
