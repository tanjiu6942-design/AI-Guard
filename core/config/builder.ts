import type { MihomoConfig, Mode } from './types.js';
import { buildRules } from './rules.js';
import { buildGroups, buildProviders, buildResidentialProxy, subscriptionHost, type ResidentialCred } from './groups.js';
import { buildDns } from './dns.js';

export interface BuildOptions {
  mode: Mode;
  sets: Record<string, string[]>;
  residential: ResidentialCred;
  airportUrl: string;
  mixedPort: number;
  controllerPort: number;
  secret: string;
  homeRegion: string;
  tunEnabled: boolean;
  interfaceName?: string;
}

export function buildConfig(opts: BuildOptions): MihomoConfig {
  const rules = buildRules(opts.mode, opts.sets);
  const groups = buildGroups();
  const providers = buildProviders(opts.airportUrl);

  // 住宅节点填入 guard-ip provider
  providers['guard-ip'] = {
    type: 'inline',
    payload: [buildResidentialProxy(opts.residential)],
  };

  // DNS 只需要 AI 相关域名, 从规则中提取
  const aiRules = Object.values(opts.sets).flat();

  // 订阅域名: 信源, 需要直连解析与直连拉取(见 groups.ts 的说明)
  const sourceHost = subscriptionHost(opts.airportUrl);

  // IPv6 必须和 TUN 绑定:
  // - 不开 TUN 时 ipv6=false: 内核对 v6 不做处理, 系统按原生 v6 走(那是我们管不到的)
  // - 开 TUN 时 ipv6=true: 否则内核不会为 TUN 建立 v6 地址和 ::/0 路由,
  //   结果"配置里写着 inet6-address, 实际 Meta 网卡没有 IPv6 地址,
  //   IPv6 流量全绕过隧道"(实测踩过: ipcheck 报 IPv6 泄漏)
  const ipv6On = opts.tunEnabled;

  return {
    'mixed-port': opts.mixedPort,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: ipv6On,
    'external-controller': `127.0.0.1:${opts.controllerPort}`,
    secret: opts.secret,

    // 进程名规则(PROCESS-NAME)必须开启进程识别才生效。
    // 不开的话 mihomo 只按域名匹配, 桌面版分流规则形同不存在 ——
    // 实测踩过: 配了 PROCESS-NAME,ChatGPT.exe 但日志里所有流量都按
    // DomainSuffix 匹配, 进程规则从未命中。
    'find-process-mode': 'strict',

    // 并发建连: 同时向多个 IP 发起连接, 取最先成功的。
    // 跨境链路下能明显降低首包延迟。
    'tcp-concurrent': true,
    // 统一延迟算法: 测速时发多次请求取平均, 避免单次抖动误判节点质量
    'unified-delay': true,

    // ── TCP keep-alive ──
    // ChatGPT 的流式回复在"思考"阶段可能有十几秒不发数据, 期间连接必须活着。
    // mihomo 默认 keep-alive-idle 较大/或不主动探测, 实测纯空闲隧道在 16.8s
    // 就被关掉, 表现为界面 "Reconnecting... waiting for network" + 卡在正在思考。
    // 把 idle 降到 10s 并每 5s 探测一次, 让中间设备和上游都认为连接活跃。
    'keep-alive-idle': 10,
    'keep-alive-interval': 5,
    ...(opts.interfaceName ? { 'interface-name': opts.interfaceName } : {}),

    tun: {
      enable: opts.tunEnabled,
      stack: 'mixed',
      'auto-route': true,
      'auto-detect-interface': !opts.interfaceName,
      'dns-hijack': ['any:53'],
      'inet6-address': ['fdfe:dcba:9876::1/126'],
    },
    proxies: [],
    'proxy-groups': groups,
    'proxy-providers': providers,
    rules,
    dns: buildDns(aiRules, opts.homeRegion, ipv6On, sourceHost),
    profile: {
      'store-selected': true,
      'store-fake-ip': true,
    },
  };
}
