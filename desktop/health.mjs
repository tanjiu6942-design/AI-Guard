import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { proxyFetch } from './network.mjs';
import { stunProbe, longConnProbe } from './probes.mjs';
import { checkLongConnection } from '../dist/core/doctor/long-connection.js';
import { checkWebrtc } from '../dist/core/doctor/webrtc.js';

const item = (key, title, state, detail, critical = state === 'fail') => ({ key, title, state, detail, critical });

export function checkDnsPolicy(dns, sourceHost) {
  if (!dns) return item('dns-policy', 'DNS 上游策略', 'unknown', '无法读取已加载的 DNS 上游配置', false);
  const protectedResolvers = new Set(['https://1.1.1.1/dns-query#AI Guard 专用']);
  const protectedList = values => Array.isArray(values) && values.length > 0 && values.every(v => protectedResolvers.has(v));
  const cnResolvers = new Set(['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query']);
  const policies = Object.entries(dns['nameserver-policy'] || {});
  const safe = dns.enable === true && protectedList(dns.nameserver)
    && !dns.fallback?.length && !dns['direct-nameserver']?.length
    && policies.every(([key, values]) =>
      key === 'geosite:cn'
        ? Array.isArray(values) && values.every(v => cnResolvers.has(v))
        : key === sourceHost
          ? Array.isArray(values) && values.length === 1 && values[0] === '223.5.5.5'
          : protectedList(values));
  return item('dns-policy', 'DNS 上游策略', safe ? 'ok' : 'fail', safe
    ? '已加载策略将普通域名交给住宅链路的加密 DNS；订阅和代理节点保留引导解析。浏览器实际解析出口需外部复测'
    : '普通域名的 DNS 上游存在直连、回退或未认可的解析器');
}

function addressValue(address) {
  address = address.split('%')[0];
  const family = isIP(address);
  if (family === 4) return { family, bits: 32, value: address.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n) };
  if (family !== 6) throw Error('Invalid route address');
  // Windows may format an IPv4-mapped IPv6 prefix with a dotted final word.
  address = address.replace(/(\d+\.\d+\.\d+\.\d+)$/, dotted => {
    const n = addressValue(dotted).value;
    return `${(n >> 16n).toString(16)}:${(n & 65535n).toString(16)}`;
  });
  const [left, right] = address.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return { family, bits: 128, value: words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n) };
}

function prefixRange(prefix) {
  const [address, lengthText, extra] = prefix.split('/');
  const { family, bits, value } = addressValue(address);
  const length = Number(lengthText);
  if (extra !== undefined || !/^\d+$/.test(lengthText) || !Number.isInteger(length) || length < 0 || length > bits) throw Error('Invalid route prefix');
  const shift = BigInt(bits - length), start = (value >> shift) << shift;
  return { family, bits, length, start, end: start + (1n << shift) };
}

// Evaluate every interval where longest-prefix selection can change. A cheaper
// default cannot beat a /1, but a competing /1 or public subnet can bypass TUN.
function ownsInternetRoutes(routes, family, localNetworks = []) {
  const local = (family === 4 ? [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4',
  ] : ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']).map(prefixRange);
  for (const prefix of localNetworks) {
    const range = prefixRange(prefix);
    if (range.family === family && range.length >= (family === 4 ? 24 : 64)) local.push(range);
  }
  const candidates = [];
  try {
    for (const route of routes) {
      const range = prefixRange(route.prefix);
      if (range.family !== family) continue;
      // Only local address ranges are exempt. Public host routes must also
      // select the protected interface.
      if (local.some(r => range.start >= r.start && range.end <= r.end)) continue;
      // InterfaceMetric 缺失时按 0 处理, 不能因此断言"未接管"。
      //
      // 实测: readProtectionSnapshot 用 Get-NetIPInterface 取 InterfaceMetric,
      // Meta 虚拟网卡常常取不到($null), 于是这里 typeof 不是 number ->
      // 直接 return false -> tun / ipv6 双双判"接管失效" ->
      // 连续两轮后触发整机断流, 而实际路由完全正常(实测确认:
      // 同一份路由数据把 InterfaceMetric 补 0 后, tun 与 ipv6 都变 ok)。
      //
      // RouteMetric 取不到才是真的异常(那说明路由数据本身不可信)。
      const rm = route.routeMetric;
      if (typeof rm !== 'number' || !Number.isFinite(rm) || rm < 0) return false;
      const im = route.interfaceMetric;
      const imSafe = typeof im === 'number' && Number.isFinite(im) && im >= 0 ? im : 0;
      candidates.push({ ...range, iface: route.iface, metric: rm + imSafe });
    }
  } catch { return false; }
  const limit = 1n << BigInt(family === 4 ? 32 : 128);
  const boundaries = [...new Set([0n, limit, ...[...candidates, ...local].flatMap(r => [r.start, r.end])])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    if (local.some(r => start >= r.start && start < r.end)) continue;
    const matching = candidates.filter(r => start >= r.start && start < r.end);
    if (!matching.length) return false;
    const longest = Math.max(...matching.map(r => r.length));
    const specific = matching.filter(r => r.length === longest);
    const metaRoutes = specific.filter(r => r.iface === 'Meta');
    // 这一段没有任何 Meta 路由 -> 该网段确实没被接管。
    if (!metaRoutes.length) return false;
    const best = Math.min(...specific.map(r => r.metric));
    const metaBest = Math.min(...metaRoutes.map(r => r.metric));
    // Meta 明显劣于别的路由 -> 真的没接管。
    if (metaBest > best) return false;
    // Meta 与物理网卡 metric 并列最优 -> 无法确定实际走向。
    //
    // 实测踩过: mihomo 的 auto-route 给 Meta 装 0.0.0.0/0 RouteMetric=0,
    // 物理网卡 WLAN 也有一条 0.0.0.0/0 RouteMetric=0, 长期并列。
    // 旧逻辑只要并列里出现非 Meta 就判 fail, 于是 TUN 工作正常也永远报
    // "TUN 网卡或 IPv4 接管路由失效", 连续两轮后触发整机断流。
    // 并列时既不能断言"已接管"(可能真泄漏), 也不该断言"未接管"(会大量误报),
    // 所以如实返回 ambiguous, 由上层判 unknown。
    if (specific.some(r => r.metric === best && r.iface !== 'Meta')) return 'ambiguous';
  }
  return true;
}

/**
 * @param s           系统接管状态快照
 * @param ownPid      本软件内核进程 pid (排除自身)
 * @param options.gracePeriod  启动宽限期: 内核刚启动、TUN 接管尚未建立
 *
 * 启动宽限期内, "TUN 接管" 与 "IPv6 防泄漏" 的 fail 降级为 unknown。
 *
 * 原因: 内核监听端口比 TUN 网卡 up 早约 855ms(实测 23:37:59.967 vs 23:38:00.822),
 * IPv4/IPv6 接管路由建立得更晚。这段时间里读网卡必然读不到接管状态,
 * 判 fail 会让"刚启动"被当成"泄漏"而立刻整机断流 —— 实测踩过:
 * 开机即报 5 项失败并锁死整机, 而实际链路完全正常。
 *
 * 用 unknown 而不是 ok: 无法确认就如实说无法确认, 不能谎称安全。
 * 宽限期结束后(见 desktop/protection.mjs 的 STARTUP_GRACE_MS)仍不接管就判 fail,
 * 真实的接管失效不会被放过。
 */
export function evaluateSystem(s, ownPid, options = {}) {
  const takeoverDns = options.takeoverDns !== false;
  const taken = new Set(['198.18.0.2', 'fdfe:dcba:9876::2']);
  const dns = s.dns ?? [];
  const unsafe = takeoverDns ? dns.flatMap(e => (e.servers ?? []).filter(a => !taken.has(a.toLowerCase())).map(a => `${e.iface}: ${a}`)) : [];
  const dnsComplete = dns.length > 0 && dns.every(e => e.servers?.length > 0);
  const others = (s.processes ?? []).filter(p => p.pid !== ownPid);
  const route4 = Array.isArray(s.routes) ? ownsInternetRoutes(s.routes, 4, s.localNetworks) : s.route4;
  const route6 = Array.isArray(s.routes) ? ownsInternetRoutes(s.routes, 6, s.localNetworks) : s.route6;
  const grace = options.gracePeriod === true;
  /**
   * 路由接管的三种结论:
   *   true       已接管
   *   false      该网段压根没有 Meta 路由 -> 真的没接管
   *   'ambiguous' Meta 与物理网卡 metric 并列最优 -> 无法确定走哪条
   *
   * 并列时判 fail 会造成大量误报(实测: mihomo auto-route 给 Meta 装 0.0.0.0/0
   * RouteMetric=0, 物理网卡也是 0, 一直并列), 连续两轮就整机断流;
   * 但判 ok 又可能在真的泄漏时说没事。所以如实报 unknown —— 无法判断。
   */
  const tunOk = s.tunUp && route4 === true;
  const tunAmbiguous = s.tunUp && route4 === 'ambiguous';
  const ipv6Ok = !s.hasPublicIpv6 || (s.tunIpv6 && route6 === true);
  const ipv6Ambiguous = s.hasPublicIpv6 && s.tunIpv6 && route6 === 'ambiguous';
  return [
    item('tun', 'TUN 接管',
      tunOk ? 'ok' : (grace || tunAmbiguous) ? 'unknown' : 'fail',
      tunOk ? '虚拟网卡在线，IPv4 路由已接管'
        : tunAmbiguous ? 'Meta 与物理网卡的接管路由优先级并列，无法确定实际走向'
        : grace ? '内核启动中，TUN 网卡与接管路由尚未建立'
        : 'TUN 网卡或 IPv4 接管路由失效'),
    item('dns', 'DNS 接管',
      !takeoverDns ? 'ok'
        : !dnsComplete ? 'unknown'
        : unsafe.length ? 'fail'
        : 'ok',
      !takeoverDns ? '免改网卡模式：由 TUN 内核透明劫持 53 端口 (dns-hijack)，物理网卡保持正常 DHCP'
        : !dnsComplete ? '无法确认在线物理网卡的 DNS 配置'
        : unsafe.length ? `DNS 配置偏离隧道地址：${unsafe.join('、')}`
        : '在线物理网卡 DNS 已接管'),
    item('ipv6', 'IPv6 防泄漏',
      ipv6Ok ? 'ok' : (grace || ipv6Ambiguous) ? 'unknown' : 'fail',
      !s.hasPublicIpv6 ? '没有物理网卡公网 IPv6'
        : ipv6Ok ? 'IPv6 隧道地址和优先路由正常'
        : ipv6Ambiguous ? 'Meta 与物理网卡的 IPv6 接管路由优先级并列，无法确定实际走向'
        : grace ? '内核启动中，IPv6 隧道地址与优先路由尚未建立'
        : '公网 IPv6 存在，但隧道地址或优先路由失效'),
    item('conflict', '代理冲突', others.length || s.otherTun?.length ? 'warn' : 'ok', others.length || s.otherTun?.length ? `检测到其他代理或隧道：${[...others.map(p => p.name), ...(s.otherTun ?? [])].join('、')}` : '未检测到其他代理或活动隧道', false),
  ];
}

export function readProtectionSnapshot() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$adapters = @(Get-NetAdapter)
$tun = @($adapters | Where-Object { $_.Name -eq 'Meta' -and $_.Status -eq 'Up' })
$phys = @($adapters | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' })
$dns = @($phys | ForEach-Object { $a=$_; $servers=@(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex | ForEach-Object { $_.ServerAddresses }); [pscustomobject]@{iface=$a.Name;servers=$servers} })
$ips = @(Get-NetIPAddress -AddressFamily IPv6)
$public = @($ips | Where-Object { $_.InterfaceIndex -in @($phys.ifIndex) -and $_.IPAddress -notmatch '^(fe80|fc|fd|::1)' })
$interfaces = @(Get-NetIPInterface)
$metrics = @{}
foreach ($family in @('ipv4','ipv6')) {
  $rows = @(netsh interface $family show interfaces)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read interface metrics' }
  foreach ($row in $rows) {
    if ($row -match '^\s*(\d+)\s+(\d+)\s+\d+\s+') { $metrics["$family/$($Matches[1])"] = [int]$Matches[2] }
  }
}
$routes = @(Get-NetRoute | Where-Object { $_.State -ne 'Dead' } | ForEach-Object {
  $r=$_; $im=($interfaces | Where-Object { $_.InterfaceIndex -eq $r.InterfaceIndex -and $_.AddressFamily -eq $r.AddressFamily } | Select-Object -First 1 -ExpandProperty InterfaceMetric)
  $family = if ([int]$r.AddressFamily -eq 2) { 'ipv4' } else { 'ipv6' }
  $key = "$family/$($r.InterfaceIndex)"
  if ($metrics.ContainsKey($key)) { $im = $metrics[$key] }
  if ($null -eq $im) { throw "Missing interface metric for $key" }
  $im = [int]$im
  [pscustomobject]@{ prefix=$r.DestinationPrefix; iface=$r.InterfaceAlias; routeMetric=[int]$r.RouteMetric; interfaceMetric=$im }
})
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'clash|mihomo|v2ray|xray|sing-box|hysteria|tuic|wireguard|openvpn|surge|quantumult' } | ForEach-Object { [pscustomobject]@{name=$_.Name;pid=$_.ProcessId} })
[pscustomobject]@{
 tunUp=($tun.Count -eq 1); dns=$dns
 routes=$routes
 localNetworks=@($ips | Where-Object { $_.InterfaceIndex -in @($phys.ifIndex) -and $_.PrefixLength -ge 64 } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
 hasPublicIpv6=($public.Count -gt 0)
 tunIpv6=(@($ips | Where-Object { $_.InterfaceAlias -eq 'Meta' -and $_.IPAddress -notmatch '^fe80' }).Count -gt 0)
 processes=$processes
 otherTun=@($adapters | Where-Object { $_.Status -eq 'Up' -and $_.Name -ne 'Meta' -and $_.InterfaceDescription -match 'Mihomo|Clash|TUN|TAP|WireGuard' } | Select-Object -ExpandProperty Name)
} | ConvertTo-Json -Compress -Depth 5
`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 12000, encoding: 'utf8' }, (error, out, err) => {
      if (error) return reject(Error(`系统接管状态采集失败：${String(err || error.message).trim()}`));
      try { resolve(JSON.parse(out.trim())); } catch { reject(Error('系统接管状态返回无效数据')); }
    }));
}

export function createHealthChecker({ settings, controller, probePort, corePid,
  systemSnapshot = readProtectionSnapshot, fetchFn = url => proxyFetch(probePort, url),
  stun = stunProbe, long = longConnProbe(probePort, 30000), inStartupGrace = () => false, getDnsConfig }) {
  let baseline = null;
  /**
   * 出口一致性探测端点。
   *
   * 这三个域名必须都真的提供 /cdn-cgi/trace, 否则该项永远只能拿到 1/3 或 2/3,
   * 表现为"出口一致性：1/3 个端点可验证, 尚不能完整确认" —— 实测踩过:
   * security.cloudflare-dns.com 与 family.cloudflare-dns.com 直连就返回 403,
   * 它们不提供 trace 端点, 拿来当探测目标只能白白拉低可验证数。
   *
   * 现有三个都实测返回 200 并带 ip= 行:
   *   cloudflare-dns.com / www.cloudflare.com / challenges.cloudflare.com
   */
  const targets = ['cloudflare-dns.com', 'www.cloudflare.com', 'challenges.cloudflare.com'];

  /**
   * 单个端点探测。
   *
   * 报错信息里出现 "socket disconnected before secure TLS connection was established"，
   * 表示 CONNECT 隧道已建立、但在 TLS 握手完成前被对端关闭 —— 这是住宅 SOCKS5
   * 跨境通道拥塞时的典型表现（实测 16 并发全部成功，但每个耗时 10 秒；
   * 并发越高排队越久，越过探针超时就被判成未响应）。
   */
  async function probeHost(host) {
    try {
      const r = await fetchFn(`https://${host}/cdn-cgi/trace`);
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      const ip = /^ip=(.+)$/m.exec(await r.text())?.[1]?.trim();
      if (!ip) throw Error('响应缺少出口 IP');
      return { ip, error: null };
    } catch (e) {
      const detail = String(e.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 200);
      return { ip: null, error: `${host}: ${detail}` };
    }
  }

  async function exit() {
    // 第一轮并发：正常情况一次拿到全部结果，耗时最短。
    const first = await Promise.all(targets.map(probeHost));

    /*
     * 第二轮串行补探：只对第一轮失败的端点重试一次，且**串行**执行。
     *
     * 为什么不是加大并发或直接判 unknown：这三个探针走的是同一条住宅隧道，
     * 三路并发本身就在互相抢通道。第一轮失败往往是排队而非链路真断，
     * 此时再并发重试只会让拥塞更严重。改成串行，一次只占一个连接，
     * 排队压力立刻下降，能显著减少"全部无响应"的误报。
     */
    const results = [...first];
    for (let i = 0; i < results.length; i++) {
      if (results[i].ip) continue;
      results[i] = await probeHost(targets[i]);
    }

    const errors = results.filter(r => r.error).map(r => r.error);
    const found = results.map(r => r.ip).filter(Boolean);
    if (!found.length) return item('exit', '出口一致性', 'unknown', `所有受保护公共探测端点均未响应（${errors.join('；')}）`, false);
    if (new Set(found).size !== 1) return item('exit', '出口一致性', 'fail', '公共探测端点观察到不一致的出口');
    if (baseline && found[0] !== baseline) return item('exit', '出口一致性', 'fail', `实际出口改变：${baseline} → ${found[0]}`);
    if (found.length !== targets.length) return item('exit', '出口一致性', 'warn', `${found.length}/${targets.length} 个端点可验证，尚不能完整确认`, false);
    baseline ??= found[0];
    return item('exit', '出口一致性', 'ok', `出口保持一致：${baseline}`);
  }
  async function local() {
    const [snapshot, configs, rules] = await Promise.all([systemSnapshot(), controller('configs'), controller('rules')]);
    const items = evaluateSystem(snapshot, corePid, { gracePeriod: inStartupGrace(), takeoverDns: settings?.takeoverDns !== false });
    if (getDnsConfig) {
      let sourceHost;
      try { sourceHost = new URL(settings.airportUrl).hostname; } catch {}
      items.push(checkDnsPolicy(getDnsConfig(), sourceHost));
    }
    if (!configs.tun?.enable || configs.mode !== 'rule') items.push(item('kernel', '内核策略', 'fail', 'TUN 或规则模式未启用'));
    else {
      const stunRule = rules.rules?.some(r => r.proxy === 'REJECT' && r.type === 'AND' && /Network,udp/i.test(r.payload) && /DstPort,3478\/5349\/19302-19309/i.test(r.payload));
      items.push(item('kernel', '内核策略', stunRule ? 'ok' : 'fail', stunRule ? '内核与 STUN 阻断规则正常' : 'STUN 阻断规则缺失'));
    }
    return items;
  }
  return async kind => {
    if (kind === 'local') return local();
    if (kind === 'exit') return [await exit()];
    const [exitItem, observed, longItem] = await Promise.all([exit(), stun(), checkLongConnection(long, 30000)]);
    // In particular, recovery must not unlock using a 30-second-old route snapshot.
    const localItems = await local();
    const webrtc = await checkWebrtc(observed, baseline || '', exitItem.state === 'ok', settings.tunEnabled);
    return [...localItems, exitItem, { ...webrtc, critical: webrtc.state === 'fail' }, { ...longItem, critical: false }];
  };
}
