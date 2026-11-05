import type { Proxy, ProxyGroup, ProxyProvider } from './types.js';
import { G_AI, G_FRONT, G_PROXY, G_AUTO, TEST_URL, CHAIN_TIMEOUT } from './constants.js';

// 连向本机不存在的端口, 连接必然失败。
// 组绝不能为空: mihomo 会给空组填 COMPATIBLE, 而 COMPATIBLE 就是直连, 会暴露真实 IP
export const GUARD: Proxy = {
  name: 'AI Guard · 未就绪(阻断)',
  type: 'socks5',
  server: '127.0.0.1',
  port: 9,
};

export interface ResidentialCred {
  server: string;
  port: number;
  username: string;
  password: string;
}

/**
 * 住宅独享出口节点的名称。
 *
 * 单独导出成常量是因为体检模块要靠这个名字核对"链路是否真的经过了独享 IP"
 * (mihomo 的连接快照里 chains 记的就是节点名)。字符串一旦在两处各写一遍,
 * 改一处就静默失配, 体检会误报"未经过独享 IP"。
 */
export const RESIDENTIAL_PROXY_NAME = 'AI Guard · 独享 IP';

/**
 * 可直连的公共 DNS(明文 IP)。
 *
 * 必须是明文 IP 而不是 DoH: mihomo 用 default-nameserver 去解析 DNS 服务器地址本身,
 * 若 default-nameserver 是 DoH 形式就自举失败(实测订阅拉取直接 EOF)。
 * 明文 IP 还能被 IP-CIDR 直连规则放行, 不受受保护模式的 MATCH,REJECT 影响。
 */
export const SOURCE_DNS_IPS = ['223.5.5.5', '119.29.29.29'];

export function buildResidentialProxy(cred: ResidentialCred): Proxy {
  return {
    name: RESIDENTIAL_PROXY_NAME,
    type: 'socks5',
    server: cred.server,
    port: cred.port,
    username: cred.username,
    password: cred.password,
    udp: true,
    'dialer-proxy': G_FRONT,   // 国内无法直连, 必需前置中转
  };
}

export function buildGroups(): ProxyGroup[] {
  return [
    {
      name: G_AI,
      type: 'fallback',   // 不用 select: store-selected 会记住"阻断"
      use: ['guard-ip', 'guard-block'],
      url: TEST_URL,
      interval: 60,
      timeout: CHAIN_TIMEOUT,
    },
    {
      // 不依赖「普通代理」：它是 select 组，默认指向 url-test 自动选择，
      // 而自动选择会按延迟不停换节点。前置节点一换，住宅 dialer-proxy 就得重建，
      // 在途 TLS 握手被掐断（实测：探测报 socket disconnected before TLS established）。
      // 住宅出口只有一个，前置只需要「一个稳定可用的节点」，fallback 取第一个可用即最稳。
      name: G_FRONT,
      type: 'fallback',
      use: ['airport-sub'],
      url: TEST_URL,
      interval: 120,
      lazy: true,
      timeout: CHAIN_TIMEOUT,
    },
    {
      // 自动选择: 在机场节点里按实测延迟选最快的。
      // 从 早期实现 迁移 —— 它的「自动选择」组就是 url-test。
      // 普通代理组可以手动选到它, 省去每次自己挑节点的麻烦。
      name: G_AUTO,
      type: 'url-test',
      use: ['airport-sub'],
      url: TEST_URL,
      interval: 300,
      tolerance: 50,
      lazy: true,
    },
    {
      name: G_PROXY,
      type: 'select',
      use: ['airport-sub'],
      proxies: [G_AUTO],
    },
  ];
}

/**
 * 机场订阅的域名(不含端口与路径)。
 *
 * 订阅是"信源"而不是"要保护的业务流量": 它提供前置节点, 而前置节点又必须
 * 经住宅 IP 才能出海 —— 所以订阅本身无法走住宅 IP(循环依赖), 只能直连拉取。
 */
export function subscriptionHost(airportUrl: string): string | null {
  if (typeof airportUrl !== 'string' || !airportUrl) return null;
  // desktop/worker.mjs 的 makeYaml 会把用户填的 URL 用 JSON.stringify 包上引号
  // 再交给序列化器, 所以这里拿到的可能带引号。带引号时 new URL() 会解析失败,
  // 导致热重载时信源规则丢掉订阅域名 —— 实测踩过: 热重载后订阅域名被自家
  // MATCH,REJECT 拒掉, 探测端点全无响应, 整机断流。
  const raw = airportUrl.trim();
  const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1)
    : raw;
  try {
    const host = new URL(unquoted).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * 信源放行规则: 必须在受保护模式的 MATCH,REJECT 之前。
 *
 * 受保护模式把 MATCH,REJECT 放在规则首位(见 desktop/protected-config.mjs),
 * 内核自己拉订阅 / 查 DNS 的流量也会走规则匹配, 于是被自己的规则拒死:
 *   订阅拉不到 -> 机场组为空 -> 住宅节点失去前置 -> 住宅链路超时
 * 实测踩过: 机场 provider 报 EOF, 前置组 now=COMPATIBLE(等于直连), 探测端点全无响应,
 * 最终触发整机断流, 而断流后复检又依赖同一个不可用的前置, 形成死锁。
 *
 * 放行的是"信源": 订阅域名直连, 公共 DNS 直连。这不影响 AI 业务流量的保护 ——
 * AI 域名仍然进 AI Guard 专用组走住宅独享 IP。
 */
export function buildSourceRules(airportUrl: string): string[] {
  const rules: string[] = [];
  const host = subscriptionHost(airportUrl);
  if (host) rules.push(`DOMAIN,${host},DIRECT`);
  // 公共 DNS: 内核解析信源域名与机场节点域名时用, 必须能直连
  for (const ip of SOURCE_DNS_IPS) rules.push(`IP-CIDR,${ip}/32,DIRECT,no-resolve`);
  return rules;
}

export function buildProviders(airportUrl: string): Record<string, ProxyProvider> {
  return {
    'guard-block': {
      type: 'inline',
      payload: [GUARD],
    },
    'guard-ip': {
      type: 'inline',
      payload: [],   // 由 builder 填入住宅节点
    },
    'airport-sub': {
      type: 'http',
      url: airportUrl,
      path: './proxies/airport.yaml',
      // 直连拉取: 机场节点是住宅 IP 的前置, 订阅走住宅 IP 会形成循环依赖
      // (住宅 IP 本机不可直连, 实测 203.0.113.7:1080 直连超时)。
      // 且受保护模式下 MATCH,REJECT 置顶会把内核自身的拉取流量一并拒掉。
      proxy: 'DIRECT',
      interval: 3600,
      'exclude-filter': '^\\s*(官网|网址)\\s*[:：]|^[^:：]{0,10}(套餐|剩余|到期|过期|重置|流量)[^:：]{0,8}[:：]|版本太旧',
      'health-check': {
        enable: true,
        url: TEST_URL,
        interval: 300,
        lazy: false,
        timeout: CHAIN_TIMEOUT,
      },
    },
  };
}