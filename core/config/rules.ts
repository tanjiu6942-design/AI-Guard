import type { Mode } from './types.js';
import { G_AI, G_PROXY } from './constants.js';

const LAN_RULES = [
  'GEOIP,private,DIRECT,no-resolve',
  'DOMAIN-SUFFIX,local,DIRECT',
  'DOMAIN-SUFFIX,lan,DIRECT',
];

// 桌面客户端 / CLI 进程名, 仅在 TUN 模式下生效
//
// 注意 ChatGPT.exe 是**例外**, 见 DESKTOP_VIA_PROXY —— 它的住宅 IP 被
// Cloudflare 挑战(Cf-Mitigated: challenge), 只能走机场 IP。
const PROCESS_RULES = [
  'PROCESS-NAME,codex.exe',
  'PROCESS-NAME,Claude.exe',
  'PROCESS-NAME,Claude Helper',
  'PROCESS-NAME,claude.exe',
];

/**
 * 桌面版 ChatGPT 单独走机场 IP(普通代理组), 而不是住宅 IP。
 *
 * 为什么: 实测住宅 IP 203.0.113.7 在 ip-api 上是 `proxy: true`,
 * Cloudflare 据此对 chatgpt.com/backend-api/* 返回
 *   403 + Cf-Mitigated: challenge
 * 而同一个端点用机场 IP 访问是 200 OK。桌面版是 Electron, 人机验证
 * 过不去 → 界面无限 "Reconnecting... waiting for network"。
 * 网页版是真实 Chrome, 能执行挑战脚本, 所以网页版一直正常。
 *
 * 代价: 桌面版的出口不再是住宅 IP, 防封效果弱于网页版。
 * 这是 IP 信誉问题, 软件层面只能这样绕过; 换到未被标记的住宅 IP
 * 后把 DESKTOP_VIA_PROXY 设为 false 即可恢复。
 */
const DESKTOP_VIA_PROXY = false;

// 严格模式专属: Cloudflare 全家桶兜底
// 修复 a.nel.cloudflare.com 走错出口的根因
const CLOUDFLARE_CATCH_ALL = [
  'DOMAIN-SUFFIX,cloudflare.com',
  'DOMAIN-SUFFIX,cloudflare-dns.com',
];

/**
 * 公共 DoH 域名 + 其 IP 地址 —— 从 早期实现 迁移过来的漏项。
 *
 * 为什么需要单独处理:
 * TUN 的 `dns-hijack: any:53` 只能拦截 **53 端口** 的明文 DNS 查询。
 * 而 DoH(DNS over HTTPS) 走 **443 端口**, 完全绕过劫持。如果不显式
 * 把这些域名/IP 收进专用组, 应用用 1.1.1.1/dns-query 解析时, 请求会
 * 从**机场 IP** 出去 —— 实测确认: 1.1.1.1 的请求 using 普通代理[美国S02]。
 *
 * 早期实现 用 `IP-CIDR,1.1.1.1/32,专用,no-resolve` 这类规则解决,
 * 这里连域名一起补, 覆盖面更全。
 */
const DOH_DOMAINS = [
  'DOMAIN,dns.google',
  'DOMAIN,dns.google.com',
  'DOMAIN,dns64.dns.google',
  'DOMAIN-SUFFIX,cloudflare-dns.com',
  'DOMAIN,one.one.one.one',
  'DOMAIN,dns.quad9.net',
  'DOMAIN,dns11.quad9.net',
  'DOMAIN-SUFFIX,dns.nextdns.io',
  'DOMAIN,doh.opendns.com',
  'DOMAIN,dns.adguard-dns.com',
  'DOMAIN,dns.twnic.tw',
  'DOMAIN-SUFFIX,doh.espr.fun',
  'DOMAIN,doh.libredns.gr',
  'DOMAIN-SUFFIX,ibuki.cgnat.net',
];

/** 公共 DoH 服务器的 IP, no-resolve 表示不再反查域名 */
const DOH_IPS = [
  'IP-CIDR,8.8.8.8/32',
  'IP-CIDR,8.8.4.4/32',
  'IP-CIDR,1.1.1.1/32',
  'IP-CIDR,1.0.0.1/32',
  'IP-CIDR,9.9.9.9/32',
];
// WebRTC 的 STUN 走 UDP 打洞, 完全绕过 HTTP 代理, 代理层无法拦截——
// 只能在内核层把这些 UDP 端口封掉, 让浏览器拿不到真实 IP。
// 3478/5349 = 标准 STUN/TURN, 19302-19309 = Google STUN。
const STUN_REJECT = 'AND,((NETWORK,UDP),(DST-PORT,3478/5349/19302-19309)),REJECT';

/**
 * QUIC(UDP/443) 一律拦截, 逼所有客户端回退 TCP。
 *
 * 为什么不能只按域名拦:
 * 住宅 IP 是 SOCKS5 代理, 而 SOCKS5 的 UDP 转发(ASSOCIATE)在跨境链路上
 * 极不可靠 —— 实测日志里 ChatGPT 桌面版发出 18 个 UDP/443(QUIC) 请求,
 * 走的全是住宅 IP, 但 UDP 收不到响应, 桌面版于是无限重连, 界面卡在
 * "Reconnecting... waiting for network"。而网页版(Chrome)默认走 TCP,
 * 所以一直没事 —— 这就是"网页能用、桌面版不能用"的根因。
 *
 * 早先按域名白名单拦截失败过两次:
 *   1) 把 challenges.cloudflare.com 也拦了 → 人机验证的 UDP 被 REJECT,
 *      验证过不去, 桌面版照样重连。
 *   2) 只拦 AI 域名集里的域名 → a.nel.cloudflare.com / update.googleapis.com
 *      / gstatic 这些动态查询的域名漏网, 它们的 UDP 继续走不稳定的 SOCKS5。
 *
 * 所以改成两条规则(不用 NOT, 兼容性最稳):
 *   1. 人机验证域名 → 走专用组(放行, 允许 UDP)
 *   2. 其余所有 UDP/443 → REJECT, 强制回退 TCP
 * 顺序很重要: 放行规则必须排在拦截规则前面。
 */
const QUIC_BLOCK_ALL = 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT';

/** 人机验证域名必须放行 UDP, 否则桌面版验证过不去 */
const CHALLENGE_PASS = 'AND,((NETWORK,UDP),(DST-PORT,443),(DOMAIN,challenges.cloudflare.com))';

export function buildRules(mode: Mode, sets: Record<string, string[]>): string[] {
  const aiRules: string[] = [];

  for (const list of Object.values(sets)) {
    for (const r of list) aiRules.push(`${r},${G_AI}`);
  }

  /**
   * Cloudflare 兜底在 strict 与 precise 下都启用。
   *
   * 原实现只在 strict 里有，precise 的设计意图是"仅 AI 主域名走住宅"，
   * 但实测踩过：precise 下 a.nel.cloudflare.com 落到 MATCH 走机场 IP，
   * 而 ChatGPT 的遥测/挑战正是走这个域名 —— 出口一跳变，界面立刻无限
   * "Reconnecting... waiting for network"。这是立项时的原始 bug。
   *
   * 兜底只覆盖 cloudflare.com / cloudflare-dns.com 两个后缀，范围极小，
   * 不会破坏 precise"尽力省流量"的初衷，但能兜住这类未列入规则集的
   * Cloudflare 子域。global 本来就把一切都送住宅，无需重复添加。
   */
  if (mode === 'strict' || mode === 'precise') {
    for (const r of CLOUDFLARE_CATCH_ALL) aiRules.push(`${r},${G_AI}`);
  }

  // 国内 DoH 服务器走 DIRECT 直连，避免国内域名解析拖垮海外住宅 SOCKS5 链路
  const DOMESTIC_DOH = ['DOMAIN,doh.pub', 'DOMAIN,dns.alidns.com', 'DOMAIN,doh.360.cn'];
  for (const r of DOMESTIC_DOH) aiRules.push(`${r},DIRECT`);

  // 海外公共 DoH 域名与 IP 进专用组, 防止绕过 dns-hijack 从机场 IP 泄漏解析
  aiRules.push(`DOMAIN,ipwho.is,${G_AI}`);
  for (const r of DOH_DOMAINS) aiRules.push(`${r},${G_AI}`);
  for (const r of DOH_IPS) aiRules.push(`${r},${G_AI},no-resolve`);

  for (const p of PROCESS_RULES) aiRules.push(`${p},${G_AI}`);

  // 桌面版专属规则必须排在所有域名规则**之前**, 否则
  // DOMAIN-SUFFIX,chatgpt.com 会先命中, 进程规则永远轮不到。
  const desktopRules = DESKTOP_VIA_PROXY
    ? [
        // 桌面版的 Cloudflare 挑战全靠这个, 必须和主站同一个出口
        `PROCESS-NAME,ChatGPT.exe,${G_PROXY}`,
      ]
    : [`PROCESS-NAME,ChatGPT.exe,${G_AI}`];

  // QUIC 处理顺序必须是: 放行验证域名 → 拦截其余 UDP/443 → 再走正常规则
  const noQuic = [
    `${CHALLENGE_PASS},${G_AI}`,
    QUIC_BLOCK_ALL,
  ];

  // 全局模式: 除了明确该直连的(内网/国内), 其余全部走住宅 IP。
  // 代价是住宅 IP 流量消耗大(视频、下载都算), 但出口绝对统一。
  if (mode === 'global') {
    return [
      ...LAN_RULES,
      STUN_REJECT,
      ...noQuic,
      ...desktopRules,
      ...aiRules,
      // 国内站点仍直连: 走住宅 IP 会让国内服务变慢, 且没有防封意义
      'GEOSITE,cn,DIRECT',
      'GEOIP,CN,DIRECT',
      `MATCH,${G_AI}`,
    ];
  }

  return [
    ...LAN_RULES,
    STUN_REJECT,
    ...noQuic,
    ...desktopRules,
    ...aiRules,
    'GEOSITE,cn,DIRECT',
    'GEOIP,CN,DIRECT',
    `MATCH,${G_PROXY}`,
  ];
}
