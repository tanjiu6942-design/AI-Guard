/**
 * 分流模式:
 * - strict  严格: AI 域名 + Cloudflare 全家桶走住宅 IP, 其余走机场
 * - precise 精确: 仅 AI 主域名走住宅 IP, 其余走机场
 * - global  全局: 除内网与国内站点外, 全部走住宅 IP(流量消耗最大, 出口最统一)
 */
export type Mode = 'strict' | 'precise' | 'global';

export interface Proxy {
  name: string;
  type: string;
  server: string;
  port: number;
  username?: string;
  password?: string;
  udp?: boolean;
  'dialer-proxy'?: string;
}

export interface ProxyGroup {
  name: string;
  type: 'select' | 'fallback' | 'url-test';
  proxies?: string[];
  use?: string[];
  url?: string;
  interval?: number;
  timeout?: number;
  lazy?: boolean;
  /** url-test 专用: 延迟差异小于该值时不切换节点, 避免频繁抖动 */
  tolerance?: number;
}

export interface ProxyProvider {
  type: 'http' | 'inline' | 'file';
  url?: string;
  path?: string;
  interval?: number;
  proxy?: string;
  payload?: Proxy[];
  'health-check'?: {
    enable: boolean;
    url: string;
    interval: number;
    lazy: boolean;
    timeout: number;
  };
}

export interface DnsConfig {
  enable: boolean;
  ipv6: boolean;
  'enhanced-mode': 'fake-ip' | 'redir-host';
  'respect-rules': boolean;
  'default-nameserver': string[];
  nameserver: string[];
  'nameserver-policy': Record<string, string[]>;
  'proxy-server-nameserver': string[];
  'fake-ip-filter': string[];
}

export interface TunConfig {
  enable: boolean;
  stack: 'mixed' | 'system' | 'gvisor';
  'auto-route': boolean;
  'auto-detect-interface': boolean;
  'dns-hijack': string[];
  'inet6-address': string[];
}

export interface MihomoConfig {
  'mixed-port': number;
  'allow-lan': boolean;
  mode: 'rule' | 'global' | 'direct';
  'log-level': string;
  ipv6: boolean;
  /** 进程识别模式; 不设或设 off 时 PROCESS-NAME 规则不生效 */
  'find-process-mode'?: 'always' | 'strict' | 'off';
  /** 并发建连: 同时向多个 IP 建连取最快 */
  'tcp-concurrent'?: boolean;
  /** 统一延迟算法: 多次测速取平均 */
  'unified-delay'?: boolean;
  /** TCP keep-alive: idle 多少秒后开始探测 */
  'keep-alive-idle'?: number;
  /** TCP keep-alive: 探测间隔(秒) */
  'keep-alive-interval'?: number;
  'external-controller': string;
  secret: string;
  tun: TunConfig;
  proxies: Proxy[];
  'proxy-groups': ProxyGroup[];
  'proxy-providers': Record<string, ProxyProvider>;
  rules: string[];
  dns: DnsConfig;
  profile: {
    'store-selected': boolean;
    'store-fake-ip': boolean;
  };
}
