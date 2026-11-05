import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { execFile } from "node:child_process";
/** 本机是否有公网 IPv6(排除链路本地/私有段/虚拟网卡) */
function hasPublicIpv6() {
  return Object.entries(networkInterfaces()).some(
    ([name, list]) =>
      !/Meta|Mihomo|Clash|TUN|wintun/i.test(name) &&
      (list ?? []).some(
        (x) =>
          (x.family === "IPv6" || x.family === 6) &&
          !x.internal &&
          !/^(fe80|fc|fd)/i.test(x.address),
      ),
  );
}

/** STUN 探测 WebRTC 可见的公网 IP(UDP 打洞, 不走 HTTP 代理) */
function stunProbe(host = "stun.l.google.com", port = 19302, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const tx = Buffer.from(
      Array.from({ length: 12 }, () => Math.floor(Math.random() * 256)),
    );
    const req = Buffer.alloc(20);
    req.writeUInt16BE(1, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(0x2112a442, 4);
    tx.copy(req, 8);
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {}
      resolve(null);
    }, timeoutMs);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101)
        return resolve(null);
      const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
      for (let p = 20; p + 4 <= end;) {
        const type = msg.readUInt16BE(p);
        const len = msg.readUInt16BE(p + 2);
        const v = msg.subarray(p + 4, p + 4 + len);
        if (
          (type === 0x0020 || type === 0x0001) &&
          v.length >= 8 &&
          v[1] === 0x01
        ) {
          const raw = v.readUInt32BE(4);
          const n = type === 0x0020 ? (raw ^ 0x2112a442) >>> 0 : raw;
          return resolve(
            [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."),
          );
        }
        p += 4 + len + ((4 - (len % 4)) % 4);
      }
      resolve(null);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      resolve(null);
    });
    sock.send(req, port, host);
  });
}

/** 长连接保持: 建 TLS 后每 8s 发心跳, 看能否撑过 idleMs */
function longConnProbe(mixedPort, idleMs, connectTimeoutMs = 10000, proxyAuthorization) {
  const HOST = "www.cloudflare.com";
  return () =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const raw = createConnection({
        host: "127.0.0.1",
        port: Number(mixedPort),
      });
      let done = false,
        heartbeat,
        tlsSocket;
      let timer = setTimeout(() => finish(true), connectTimeoutMs);
      const finish = (closed) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        tlsSocket?.destroy();
        raw.destroy();
        resolve({ aliveMs: Date.now() - t0, closed });
      };
      raw.on("connect", () => {
        const authorizationHeader = proxyAuthorization
          ? `Proxy-Authorization: ${proxyAuthorization}\r\n`
          : "";
        raw.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n${authorizationHeader}\r\n`);
      });
      let header = Buffer.alloc(0);
      const receiveHeader = (chunk) => {
        header = Buffer.concat([header, chunk]);
        const sep = header.indexOf("\r\n\r\n");
        if (header.length > 16384) return finish(true);
        if (sep < 0) return;
        raw.removeListener("data", receiveHeader);
        if (!/^HTTP\/1\.[01] 200 /.test(header.toString())) return finish(true);
        if (header.length > sep + 4) raw.unshift(header.subarray(sep + 4));
        tlsSocket = tlsConnect(
          { socket: raw, servername: HOST, rejectUnauthorized: true },
          () => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(false), idleMs);
            // Send valid HTTP application data through TLS, not raw TLS record bytes.
            const ping = () =>
              tlsSocket.write(
                `HEAD /cdn-cgi/trace HTTP/1.1\r\nHost: ${HOST}\r\nConnection: keep-alive\r\nUser-Agent: AI-Guard/0.1\r\n\r\n`,
              );
            ping();
            heartbeat = setInterval(ping, 8000);
          },
        );
        tlsSocket.on("data", () => {});
        tlsSocket.on("error", () => finish(true));
        tlsSocket.on("close", () => finish(true));
      };
      raw.on("data", receiveHeader);
      raw.on("error", () => finish(true));
      raw.on("close", () => finish(true));
    });
}

/** 枚举代理相关进程的 名字+命令行, 用于区分自己的内核与别人的客户端 */
/** 通过监听端口反查 PID。不需要提权, 而查询管理员进程的 CommandLine 需要。 */
function pidsOnPorts(ports) {
  return new Promise((resolve) => {
    execFile(
      "netstat",
      ["-ano"],
      { windowsHide: true, timeout: 15000 },
      (_e, out) => {
        const pids = new Set();
        for (const line of String(out ?? "").split(/\r?\n/)) {
          if (!/LISTENING/i.test(line)) continue;
          if (!ports.some((p) => line.includes(":" + p + " "))) continue;
          const parts = line.trim().split(/\s+/);
          const pid = Number(parts[parts.length - 1]);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
        resolve([...pids]);
      },
    );
  });
}

/** 读物理网卡的 DNS 配置。排除 TUN 虚拟网卡, 否则会把自己的 198.18.0.2 当泄漏源。 */

/** 读 IPv6 的系统配置: 物理网卡公网地址 / TUN 是否配 IPv6 / ::\/0 默认路由指向 */
function readIpv6Snapshot() {
  const ps = [
    "$phys = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.IPAddress -notmatch '^(fe80|fc|fd|::1)' -and $_.InterfaceAlias -notmatch 'Meta|Mihomo|Clash|TUN' } |",
    "  Select-Object InterfaceAlias,IPAddress",
    "$tun = Get-NetIPAddress -InterfaceAlias Meta -AddressFamily IPv6 -ErrorAction SilentlyContinue |",
    "  Select-Object -First 1 -ExpandProperty IPAddress",
    '$r = Get-NetRoute -DestinationPrefix "::/0" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InterfaceAlias',
    "[PSCustomObject]@{",
    "  physical = @($phys | ForEach-Object { [PSCustomObject]@{ iface = $_.InterfaceAlias; addr = $_.IPAddress } })",
    "  tunHasIpv6 = [bool]$tun",
    "  routes = @($r)",
    "} | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
      (_e, out) => {
        const raw = String(out ?? "").trim();
        if (!raw)
          return resolve({
            physicalPublic: [],
            tunHasIpv6: false,
            ipv6DefaultRoutes: [],
            tunAlias: "Meta",
          });
        try {
          const o = JSON.parse(raw);
          const physArr = Array.isArray(o.physical)
            ? o.physical
            : o.physical
              ? [o.physical]
              : [];
          const routes = Array.isArray(o.routes)
            ? o.routes
            : o.routes
              ? [o.routes]
              : [];
          resolve({
            physicalPublic: physArr.filter(Boolean).map((x) => ({
              iface: String(x.iface ?? ""),
              addr: String(x.addr ?? ""),
            })),
            tunHasIpv6: !!o.tunHasIpv6,
            ipv6DefaultRoutes: routes.filter(Boolean).map(String),
            tunAlias: "Meta",
          });
        } catch {
          resolve({
            physicalPublic: [],
            tunHasIpv6: false,
            ipv6DefaultRoutes: [],
            tunAlias: "Meta",
          });
        }
      },
    );
  });
}

/**
 * 探测 TUN 的 dns-hijack 是否生效。
 * 方法: 向一个**公网 DNS**(114.114.114.114) 查询 AI 域名,
 * 若返回 fake-ip(198.18.x.x), 说明查询被 TUN 劫持 —— 没有真出网。
 * 若返回真实 IP, 说明劫持失效, DNS 请求真的送到了运营商。
 */
function dnsHijackProbe() {
  return new Promise((resolve) => {
    // nslookup 输出里找 Address 行; -timeout 限时避免卡住
    execFile(
      "nslookup",
      ["-timeout=3", "claude.ai", "114.114.114.114"],
      { windowsHide: true, timeout: 8000 },
      (_e, out) => {
        const text = String(out ?? "");
        // nslookup 输出分两段: 前段是"服务器"自身地址, 后段才是解析结果。
        // 只在「名称:」之后的段落里找 Address, 避免把服务器地址算进来。
        const nameIdx = text.search(/^\s*(?:����|Name):/m);
        const body = nameIdx >= 0 ? text.slice(nameIdx) : text;
        const addrs = [...body.matchAll(/^\s*Address(?:es)?:\s*(\S+)/gim)]
          .map((m) => m[1].trim())
          .filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
        if (!addrs.length) return resolve(null);
        // 只要解析结果里出现 fake-ip, 就说明查询被 TUN 劫持, 没有真出网
        resolve(addrs.some((a) => /^198\.18\./.test(a)));
      },
    );
  });
}

function readDnsServers() {
  const ps = [
    "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object {",
    "  $i = $_.ifIndex; $n = $_.Name",
    "  foreach ($fam in @(2,23)) {",
    "    $s = (Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily $fam -ErrorAction SilentlyContinue).ServerAddresses",
    "    if ($s) { [PSCustomObject]@{ iface = $n; family = $fam; servers = @($s) } }",
    "  }",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
      (_e, out) => {
        const raw = String(out ?? "").trim();
        if (!raw) return resolve([]);
        try {
          const arr = JSON.parse(raw);
          const list = Array.isArray(arr) ? arr : [arr];
          resolve(
            list.map((x) => ({
              iface: String(x.iface ?? ""),
              family: Number(x.family) === 23 ? 6 : 4,
              servers: (Array.isArray(x.servers) ? x.servers : [x.servers])
                .filter(Boolean)
                .map((s) => String(s)),
            })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

function listProcesses() {
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'clash|mihomo|v2ray|xray|sing-box|hysteria|tuic|wireguard|openvpn|surge|quantumult' } | " +
    "Select-Object Name,ProcessId | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
      (_e, out) => {
        const raw = String(out ?? "").trim();
        if (!raw) return resolve([]);
        try {
          const arr = JSON.parse(raw);
          const list = Array.isArray(arr) ? arr : [arr];
          resolve(
            list.map((x) => ({
              name: String(x.Name ?? ""),
              pid: Number(x.ProcessId ?? 0) || undefined,
            })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

export {
  hasPublicIpv6,
  stunProbe,
  longConnProbe,
  readIpv6Snapshot,
  dnsHijackProbe,
  readDnsServers,
  listProcesses,
};
