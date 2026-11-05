import { describe, it, expect } from "vitest";
import { createServer as createTcpServer, createConnection } from "node:net";
import { createServer as createHttpServer, request } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const runFile = promisify(execFile);
const mihomo = resolve("vendor/mihomo/mihomo.exe");
const STUN_RULE = "AND,((NETWORK,UDP),(DST-PORT,3478)),REJECT";
const loadBuilder = async () => {
  const modulePath = "../desktop/protected-config.mjs";
  const module = await import(modulePath);
  expect(module.buildProtectedYaml).toBeTypeOf("function");
  return module.buildProtectedYaml;
};
const makeConfig = (mixedPort = 17890, controllerPort = 19090, socksPort = 19080) => ({
  "mixed-port": mixedPort, "allow-lan": false, mode: "rule", "log-level": "warning",
  ipv6: false, "external-controller": `127.0.0.1:${controllerPort}`, secret: JSON.stringify("controller-test"),
  tun: { enable: false, stack: "mixed", "auto-route": false, "auto-detect-interface": false, "dns-hijack": [], "inet6-address": [] },
  proxies: [],
  "proxy-providers": {
    fixture: { type: "inline", payload: [{ name: "local-socks", type: "socks5", server: "127.0.0.1", port: socksPort, udp: false }] },
  },
  "proxy-groups": [{ name: "AI Guard 专用", type: "select", use: ["fixture"] }],
  rules: [STUN_RULE, "MATCH,DIRECT"],
  // Parser still requires a resolver with DNS disabled. Keep every target local.
  dns: { enable: false, ipv6: false, "enhanced-mode": "fake-ip", "respect-rules": false, "default-nameserver": ["127.0.0.1:9"], nameserver: ["127.0.0.1:9"], "nameserver-policy": {}, "proxy-server-nameserver": [], "fake-ip-filter": [] },
  profile: { "store-selected": false, "store-fake-ip": false },
});
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const freePort = async () => {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
};
const proxyRequest = (port, target, authorization) => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path: target,
    headers: { Host: new URL(target).host, ...(authorization ? { "Proxy-Authorization": authorization } : {}) }, agent: false }, (res) => {
    const data = [];
    res.on("data", (part) => data.push(part));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString() }));
    res.on("error", reject);
  });
  req.setTimeout(2000, () => req.destroy(Error("local proxy fixture timeout")));
  req.on("error", reject);
  req.end();
});
const waitForPort = async (port, child, output) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`fixture mihomo exited: ${output()}`);
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
      return;
    } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  throw Error(`fixture mihomo did not listen: ${output()}`);
};
const removeFixtureDir = (dir) => {
  const base = resolve(tmpdir()) + sep;
  if (!resolve(dir).startsWith(base) || !dir.includes("aiguard-protected-config-")) throw Error("unsafe fixture cleanup path");
  rmSync(dir, { recursive: true, force: true });
};

describe("protected mihomo configuration", () => {
  it("prepends business rejection without dropping original rules or mutating the input", async () => {
    const build = await loadBuilder();
    const config = makeConfig();
    const before = JSON.stringify(config);
    const yaml = build(config, { probePort: 17891, probeSecret: "secret", businessBlocked: true });
    // 业务拒绝规则紧跟在信源放行规则之后、原规则之前。
    //
    // 信源(公共 DNS / 订阅域名)必须排在 MATCH,REJECT 前面: mihomo 规则自上而下、
    // 首次匹配即生效, MATCH 在首位会匹配一切, 内核自己查 DNS / 拉订阅的流量会被
    // 自家规则拒死 -> 机场组为空 -> 住宅链路超时 -> 整机断流且无法复检恢复。
    // 详见 core/config/groups.ts 的 buildSourceRules 说明。
    expect(yaml).toContain(`rules:\n  - IP-CIDR,223.5.5.5/32,DIRECT,no-resolve\n  - IP-CIDR,119.29.29.29/32,DIRECT,no-resolve\n  - MATCH,REJECT\n  - ${STUN_RULE}\n  - MATCH,DIRECT\n`);
    expect(JSON.stringify(config)).toBe(before);
    expect(build(config, { probePort: 17891, probeSecret: "secret", businessBlocked: false }))
      .toContain(`rules:\n  - ${STUN_RULE}\n  - MATCH,DIRECT\n`);
  });
  it("refuses a shared business/probe port and missing probe credentials", async () => {
    const build = await loadBuilder();
    expect(() => build(makeConfig(), { probePort: 17890, probeSecret: "secret", businessBlocked: true })).toThrow(/port|端口/i);
    for (const probePort of [0, -1, 65536, 1.5, NaN]) {
      expect(() => build(makeConfig(), { probePort, probeSecret: "secret", businessBlocked: false })).toThrow(/port|端口/i);
    }
    expect(() => build(makeConfig(), { probePort: 17891, probeSecret: "", businessBlocked: true })).toThrow(/secret|认证|凭据/i);
  });
});

describe.skipIf(process.platform !== "win32" || !existsSync(mihomo))("bundled mihomo protected inbound (loopback only, no TUN)", () => {
  it("accepts both protected YAML variants with mihomo -t, including a quoted probe password", async () => {
    const build = await loadBuilder();
    const dir = mkdtempSync(join(tmpdir(), "aiguard-protected-config-"));
    try {
      for (const businessBlocked of [false, true]) {
        const path = join(dir, "config.yaml");
        writeFileSync(path, build(makeConfig(), { probePort: 17891, probeSecret: 'x: # " \\ \npassword', businessBlocked }));
        const { stdout } = await runFile(mihomo, ["-t", "-d", dir, "-f", path], { windowsHide: true, timeout: 10000 });
        expect(stdout).toMatch(/configuration file.*test.*successful/i);
      }
    } finally { removeFixtureDir(dir); }
  }, 15000);

  it("requires probe authentication, forces the residential group, and keeps the business listener blocked", async () => {
    const build = await loadBuilder();
    const dir = mkdtempSync(join(tmpdir(), "aiguard-protected-config-"));
    const sockets = new Set();
    const track = (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); return socket; };
    let requests = 0;
    let socksConnections = 0;
    const targetAuthorizations = [];
    const socksRequests = [];
    let targetPort;
    const target = createHttpServer((req, res) => {
      requests++;
      targetAuthorizations.push(req.headers["proxy-authorization"]);
      res.end("loopback residential fixture");
    });
    target.on("connection", track);
    const socks = createTcpServer((socket) => {
      track(socket);
      let buffer = Buffer.alloc(0), stage = "greeting";
      const receive = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, 0]));
          stage = "connect";
        }
        if (stage !== "connect" || buffer.length < 10) return;
        socksRequests.push(buffer.toString("hex"));
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 1 ||
          !buffer.subarray(4, 8).equals(Buffer.from([127, 0, 0, 1])) || buffer.readUInt16BE(8) !== targetPort) {
          socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return;
        }
        stage = "tunnel";
        socket.removeListener("data", receive);
        const remainder = buffer.subarray(10);
        const remote = track(createConnection({ host: "127.0.0.1", port: targetPort }, () => {
          socksConnections++;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (remainder.length) remote.write(remainder);
          socket.pipe(remote).pipe(socket);
        }));
        remote.once("error", () => socket.destroy());
        socket.once("close", () => remote.destroy());
      };
      socket.on("data", receive);
    });
    let child;
    try {
      targetPort = await listen(target);
      const socksPort = await listen(socks);
      const ports = new Set();
      while (ports.size < 3) ports.add(await freePort());
      const [mixedPort, probePort, controllerPort] = ports;
      const configPath = join(dir, "config.yaml");
      const probeSecret = 'fixture: # " \\ \npassword';
      const authorization = `Basic ${Buffer.from(`aiguard-health:${probeSecret}`).toString("base64")}`;
      writeFileSync(configPath, build(makeConfig(mixedPort, controllerPort, socksPort), { probePort, probeSecret, businessBlocked: true }));
      child = spawn(mihomo, ["-d", dir, "-f", configPath], { windowsHide: true, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { output += part; });
      await waitForPort(probePort, child, () => output);
      const url = `http://127.0.0.1:${targetPort}/check`;
      expect((await proxyRequest(probePort, url)).status).toBe(407);
      // mihomo distinguishes absent credentials (407) from invalid ones (403).
      expect((await proxyRequest(probePort, url, `Basic ${Buffer.from("aiguard-health:wrong").toString("base64")}`)).status).toBe(403);
      expect(requests).toBe(0);
      const success = await proxyRequest(probePort, url, authorization);
      expect(success, `${output}\nSOCKS requests: ${socksRequests.join(",")}`).toEqual({ status: 200, body: "loopback residential fixture" });
      expect(socksConnections).toBe(1);
      expect(requests).toBe(1);
      expect(targetAuthorizations).toEqual([undefined]);
      const connectStatus = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: probePort, method: 'CONNECT',
          path: `127.0.0.1:${targetPort}`, headers: { 'Proxy-Authorization': authorization } });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(Error('CONNECT timeout')));
        req.end();
      });
      expect(connectStatus).toBe(200);
      const ordinary = await proxyRequest(mixedPort, url).catch(() => null);
      expect(ordinary?.status).not.toBe(200);
      expect(requests).toBe(1);
    } finally {
      if (child && child.exitCode === null) {
        await new Promise((r) => { child.once("exit", r); child.kill(); });
      }
      for (const socket of sockets) socket.destroy();
      await Promise.all([target, socks].map((server) => new Promise((r) => server.close(r))));
      removeFixtureDir(dir);
    }
  }, 15000);
});
