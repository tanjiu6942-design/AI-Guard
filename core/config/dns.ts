import type { DnsConfig } from './types.js';
import { G_AI } from './constants.js';
import { SOURCE_DNS_IPS } from './groups.js';

const MAX_KEY_LEN = 800;   // 超过 1024 内核读配置会报错退出

// Ordinary application lookups always use encrypted DNS through the residential chain.
const APPLICATION_DNS = [`https://1.1.1.1/dns-query#${G_AI}`];

const FAKE_IP_FILTER = [
  '+.lan', '+.local', '+.localdomain', '+.localhost', '+.invalid',
  '+.pool.ntp.org', 'time.*.com', 'ntp.*.com', 'time.*.apple.com',
  '+.msftconnecttest.com', '+.msftncsi.com',
  'xbox.*.microsoft.com', 'xnotify.xboxlive.com', '+.srv.nintendo.net',
];

export function toDnsKey(rule: string): string {
  const [type, host] = rule.split(',');
  return type === 'DOMAIN-SUFFIX' ? `+.${host}` : host;
}

export function chunkDnsKeys(keys: string[], maxLen = MAX_KEY_LEN): string[] {
  const out: string[] = [];
  let cur = '';
  for (const k of keys) {
    if (cur && cur.length + 1 + k.length > maxLen) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur},${k}` : k;
  }
  if (cur) out.push(cur);
  return out;
}

export function buildDns(
  aiRules: string[],
  homeRegion: string,
  ipv6 = false,
  sourceHost: string | null = null,
): DnsConfig {
  const policy: Record<string, string[]> = {};

  const keys = aiRules.map(toDnsKey);
  for (const chunk of chunkDnsKeys(keys)) {
    policy[chunk] = [`https://1.1.1.1/dns-query#${G_AI}`];
  }

  // 订阅域名用直连明文 DNS 解析。
  //
  // 为什么必须单独指定: 默认 nameserver 带 #普通代理 标签, 要先经机场节点才能解析;
  // 而机场节点来自订阅 —— 首次启动时这就是循环依赖, 内核解析不出订阅域名,
  // 于是拉不到订阅, 前置组为空, 住宅 IP 失去前置而超时。
  // 给信源域名单独走直连明文 DNS, 就打破了循环, 且不影响其余域名的 DNS 分流。
  //
  // 为什么是明文 IP 而不是 DoH: mihomo 解析 DoH 服务器的引导解析走 default-nameserver,
  // 而 default-nameserver 自身若也是 DoH 就成了循环; 实测明文 IP 稳定可用。
  if (sourceHost) {
    policy[sourceHost] = SOURCE_DNS_IPS.slice(0, 1);
  }

  /**
   * 国内域名使用系统解析器直连（system#DIRECT），而不是国内 DoH。
   *
   * 为什么不能用 223.5.5.5 / doh.pub：这些公共 DoH 只是"第一跳"，它们最终仍会
   * 向运营商递归服务器要答案，DNS 泄漏检测站看到的出口就是运营商 DNS
   * （实测报出 112.25.12.136 南京 / 211.138.19.59 广东 / 2409:8088:... 广东移动）。
   * 换成 system#DIRECT 后，国内查询直接交给操作系统在校园网内的真实 DNS 解析，
   * 不再经过内核伪造的任何上游 —— 既符合运营商/校园网的合规要求，
   * 也不会被泄漏检测站误判成"内核把查询送去了境外"。
   *
   * 安全性不受影响：+ 国内域名本来就要走 DIRECT，解析结果只用于直连，
   * 不涉及 AI 域名；AI 与海外域名仍由 nameserver-policy 的其它条目走住宅加密 DNS。
   */
  /**
   * 国内域名使用加密 DoH（直连），不用 system#DIRECT。
   *
   * 为什么不用 system#DIRECT：那会把国内域名的解析明文交给本地 ISP 的
   * 递归服务器，运营商能看到你访问的每一个国内站点。实测在热点下解析器
   * 直接暴露为本地联通 DNS（61.163.252.70 / 2408:8001:100:3003::3）。
   *
   * 用 DoH 后：本地 ISP 只能看到一条到阿里/腾讯的加密 HTTPS 连接，
   * 看不到具体域名。两个 DoH 互为回退，避免单个服务不可用导致解析失败。
   * 两者都由自己的递归基础设施解析，不会转发给本地 ISP。
   *
   * 注意：泄漏检测站仍可能把阿里/腾讯的解析器标为"中国 DNS" —— 只要用
   * 国内解析器就躲不掉，除非把国内域名也送去住宅链路（那会让国内 CDN
   * 返回海外节点，站点明显变慢）。这里选的是"隐去 ISP 视角"而非"完全隐身"。
   */
  policy['geosite:cn'] = ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'];

  return {
    enable: true,
    // TUN 接管 IPv6 时必须让内核也处理 v6 解析, 否则 AAAA 查询会落到系统解析器
    ipv6,
    'enhanced-mode': 'fake-ip',
    'respect-rules': true,
    // default-nameserver 是内核解析 DNS 服务器地址本身的引导解析器, 必须是可直接
    // 连通的明文 IP —— 用 DoH 会自举失败。
    'default-nameserver': SOURCE_DNS_IPS.slice(),
    // Proxy nodes and subscription bootstrap have separate resolvers below.
    // A random website hostname must never fall back to bootstrap DNS.
    nameserver: APPLICATION_DNS.slice(),
    'nameserver-policy': policy,
    // proxy-server-nameserver 用于解析机场节点域名, 同样必须直连。
    'proxy-server-nameserver': SOURCE_DNS_IPS.slice(),
    'fake-ip-filter': FAKE_IP_FILTER,
  };
}
