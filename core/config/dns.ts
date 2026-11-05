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
