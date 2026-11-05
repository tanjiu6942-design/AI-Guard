import { connect, createServer } from "node:net";
import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildConfig } from "../dist/core/config/builder.js";
import { runAiRouteChecks } from "../dist/core/doctor/ai-route-report.js";
import { probeTraceIp } from '../dist/core/doctor/ai-route.js';
import { OrdinaryNodes } from './nodes.mjs';
import { TimezoneManager, lookupExitTimezone } from './timezone.mjs';
import { loadRuleSets } from "../dist/core/domain/rule-source.js";
import {
  configToYaml,
  ensureGeodata,
  findMihomo,
} from "../dist/core/runtime/mihomo.js";
import {
  listAdapters,
  buildApplyScript,
  buildRestoreScript,
  buildCleanupResidualDnsScript,
} from "../dist/core/runtime/sysdns.js";
import { KernelSession } from "./kernel-session.mjs";
import { requireConnection } from "./settings.mjs";
import { WindowsGuard } from './firewall.mjs';
import { WorkerProtection, emptyProtection } from './worker-protection.mjs';
import { buildProtectedYaml } from './protected-config.mjs';
import { stopProtectedSession } from './protected-stop.mjs';
import { proxyFetch } from './network.mjs';

function exec(file, args, timeout = 15000) {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout, encoding: "utf8" },
      (e, out, err) =>
        e ? reject(Error(String(err || e.message).trim())) : resolve(out),
    ),
  );
}
const ps = (script) =>
  exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        script.replace(
          "$ErrorActionPreference = 'SilentlyContinue'",
          "$ErrorActionPreference = 'Stop'",
        ),
        "utf16le",
      ).toString("base64"),
    ],
    20000,
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runWorker({ pipe, dataDir, resources, root, exit }) {
  if (!/^\\\\\.\\pipe\\aiguard-[a-f0-9]{48}$/.test(pipe))
    throw Error("Invalid worker pipe");
  const logDir = join(dataDir, "mihomo");
  let workDir = logDir;
  mkdirSync(logDir, { recursive: true });
  const log = (s) =>
    appendFileSync(
      join(logDir, "desktop.log"),
      `[${new Date().toISOString()}] ${s}\n`,
    );
  const backupPath = join(logDir, "desktop-dns-backup.json");
  const guard = new WindowsGuard({ executable: join(resources, 'guard-filter', 'aiguard-guard-filter.exe'), dataDir });
  let settings, rawChild, activeConfig, protection, probePort, probeSecret, controllerSecret;
  let lastBuiltDns, appliedDns, activeInterfaceName = null;
  const detectActiveInterface = async () => {
    try {
      const script = "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Where-Object { $_.NextHop -ne '0.0.0.0' } | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1; if ($r) { (Get-NetAdapter -InterfaceIndex $r.InterfaceIndex).Name }";
      const name = (await ps(script)).trim();
      return name || null;
    } catch { return null; }
  };
  let businessBlocked = false, intentionalStop = false, configQueue = Promise.resolve();
  async function controller(endpoint, options = {}) {
    const response = await fetch(`http://127.0.0.1:${settings.controllerPort}/${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${controllerSecret}`, 'content-type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw Error(`内核控制接口 ${endpoint}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const canSelectNode = () => session.running && (!protection || protection.snapshot().phase === 'healthy');
  const ordinaryNodes = new OrdinaryNodes({ controller, dataDir, canSelect: canSelectNode });
  const timezones = new TimezoneManager({ dataDir });
  const residentialFetch = (url, timeout = 20000) => protection
    ? proxyFetch(probePort, url, timeout, 'Basic ' + Buffer.from(`aiguard-health:${probeSecret}`).toString('base64'))
    : proxyFetch(settings.mixedPort, url, timeout);
  function updateConfig(blocked, next = settings, systemBlockConfirmed = false) {
    // Latch the requested block before queuing, so mode changes cannot erase it.
    if (blocked) businessBlocked = true;
    const task = configQueue.then(async () => {
      const candidate = join(workDir, `desktop-reload-${randomBytes(6).toString('hex')}.yaml`);
      if (protection) await guard.writeConfig(workDir, candidate.slice(workDir.length + 1), makeYaml(next, blocked));
      else writeFileSync(candidate, makeYaml(next, blocked));
      try {
        await controller('configs?force=true', { method: 'PUT', body: JSON.stringify({ path: candidate }) });
        appliedDns = lastBuiltDns;
        businessBlocked = blocked;
        settings = next;
        // 重载会拆掉并重建 TUN 网卡与接管路由, 期间读不到接管状态。
        // 重新开启宽限期, 否则重建空窗会被周期检测当成"接管失效"而整机断流
        // (实测: 00:41:49 重载 -> 同一秒断流)。
        protection?.notifyReload();
      } catch (e) {
        if (blocked && systemBlockConfirmed) rawChild?.kill();
        throw e;
      } finally { unlinkSync(candidate); }
    });
    configQueue = task.catch(() => {});
    return task;
  }
  const restoreDns = async () => {
    if (existsSync(backupPath)) {
      try {
        await ps(buildRestoreScript(JSON.parse(readFileSync(backupPath, "utf8"))));
      } finally {
        try { unlinkSync(backupPath); } catch {}
      }
    }
    // 兜底保底：即使没有备份文件（或崩溃后重启），物理网卡上残留的 TUN DNS 强制重置
    await ps(buildCleanupResidualDnsScript());
    log("DNS 已恢复");
  };
  const session = new KernelSession({
    launch: async () => {
      requireConnection(settings);
      // Recover our own previous backup before taking another snapshot.
      await restoreDns();
      if (settings.tunEnabled) {
        const conflicts = await ps(
          "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'Meta|Mihomo|Clash|TUN|TAP|WireGuard' } | Select-Object -ExpandProperty Name",
        );
        if (conflicts.trim())
          throw Error("检测到其他活动隧道网卡，请先退出其他 VPN / TUN 客户端");
      }
      const bundled = join(resources, "mihomo", "mihomo.exe");
      const sourceMihomo =
        settings.mihomoPath || (existsSync(bundled) ? bundled : findMihomo());
      if (!sourceMihomo || !existsSync(sourceMihomo))
        throw Error("找不到 mihomo，请在配置页选择 mihomo.exe");
      let mihomo = sourceMihomo;
      controllerSecret = settings.secret || 'aiguard';
      for (const port of [settings.mixedPort, settings.controllerPort]) {
        await new Promise((resolve, reject) => {
          const probe = createServer();
          probe.once("error", () =>
            reject(Error(`端口 ${port} 已被占用，请在配置页修改`)),
          );
          probe.listen(port, "127.0.0.1", () => probe.close(resolve));
        });
      }
      if (settings.realtimeProtection !== false) {
        await guard.check();
        mihomo = await guard.stageKernel(sourceMihomo);
        // All control-plane credentials and provider caches inherit the helper's
        // SYSTEM/Administrators-only directory. Never write these into AppData.
        workDir = await guard.prepareRuntime(mihomo);
        controllerSecret = randomBytes(32).toString('hex');
        probePort = await new Promise((resolve, reject) => {
          const server = createServer(); server.once('error', reject);
          server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
        });
        probeSecret = randomBytes(24).toString('hex');
        businessBlocked = true;
        protection = new WorkerProtection({
          guard,
          dataDir, settings, probePort, probeSecret, controller, configure: (blocked, confirmed) => updateConfig(blocked, settings, confirmed),
          getDnsConfig: () => appliedDns,
          log,
          emit: value => { if (!socket.destroyed) socket.write(JSON.stringify({ event: 'protection', value }) + '\n'); },
        });
        await protection.prepare(mihomo);
      }
      if (!ensureGeodata(workDir, sourceMihomo))
        throw Error('缺少 Country.mmdb / geoip.dat / geosite.dat，请放在内核同目录');
      activeInterfaceName = await detectActiveInterface();
      if (activeInterfaceName) log(`检测到物理出口网卡: ${activeInterfaceName}，已显式绑定避免 auto-detect 失败`);
      const appDataProxies = join(dataDir, "mihomo", "proxies", "airport.yaml");
      if (existsSync(appDataProxies)) {
        const destDir = join(workDir, "proxies");
        mkdirSync(destDir, { recursive: true });
        try {
          copyFileSync(appDataProxies, join(destDir, "airport.yaml"));
          log("已同步 AppData 机场节点缓存到运行目录");
        } catch (e) {
          log("同步节点缓存失败: " + e.message);
        }
      } else {
        log("AppData 中未找到机场节点缓存: " + appDataProxies);
      }
      const appDataCache = join(dataDir, "mihomo", "cache.db");
      if (existsSync(appDataCache)) {
        try { copyFileSync(appDataCache, join(workDir, "cache.db")); } catch {}
      }
      activeConfig = join(workDir, `desktop-config-${randomBytes(6).toString('hex')}.yaml`);
      // 启动配置直接用"正常态"(不带 MATCH,REJECT)。
      //
      // 启动阶段的业务流量隔离由 WFP 系统规则承担 —— prepare() 里的 guard.lock()
      // 已经在网络层阻断了除内核之外的一切应用, 这比改内核规则更彻底。
      //
      // 以前启动时发的是隔离态配置(MATCH,REJECT 置顶), 检测全绿后再 configure(false)
      // 切回正常态。而 configure() 是一次 PUT /configs 热重载, 会拆掉并重建 TUN 网卡
      // 与接管路由; 首次全量检测要跑约 35 秒(30 秒长连接 + 其余探测), 于是启动约 35 秒
      // 后必然发生一次重载 —— 实测三次断流(00:41:49 / 00:52:21 / 10:43:50)全部精确
      // 落在它上面, 表现为"检测好久才断流"。
      //
      // 现在启动即正常态, 检测通过后无需任何切换, 那条自杀链路不复存在。
      if (protection) await guard.writeConfig(workDir, activeConfig.slice(workDir.length + 1), makeYaml(settings, false));
      else writeFileSync(activeConfig, makeYaml(settings, false));
      appliedDns = lastBuiltDns;
      await exec(mihomo, ["-t", "-d", workDir, "-f", activeConfig], 30000);
      log("启动 mihomo");
      rawChild = spawn(mihomo, ["-d", workDir, "-f", activeConfig], {
        cwd: workDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let spawnError = null;
      rawChild.on("error", (e) => {
        spawnError = e;
        log(e.message);
      });
      rawChild.stdout.on("data", (d) =>
        appendFileSync(join(logDir, "desktop.log"), d),
      );
      rawChild.stderr.on("data", (d) =>
        appendFileSync(join(logDir, "desktop.log"), d),
      );
      return {
        pid: rawChild.pid,
        onExit: (fn) =>
          rawChild.once("close", async () => {
            log("mihomo 已退出");
            try {
              const updatedProxies = join(workDir, "proxies", "airport.yaml");
              if (existsSync(updatedProxies)) {
                const destDir = join(dataDir, "mihomo", "proxies");
                mkdirSync(destDir, { recursive: true });
                copyFileSync(updatedProxies, join(destDir, "airport.yaml"));
              }
              const updatedCache = join(workDir, "cache.db");
              if (existsSync(updatedCache)) {
                copyFileSync(updatedCache, join(dataDir, "mihomo", "cache.db"));
              }
            } catch {}
            // 内核退出不等于"检测到危险"。
            //
            // 只有在本进程并未主动收尾(closing=false)且用户也不是在停止时,
            // 才把它当成异常。否则程序每次正常停止/退出都会被记成一次整机断流,
            // 界面下次打开就显示"已断流", 而系统其实什么都没锁。
            if (!closing && !intentionalStop && protection) await protection.trip('内核意外退出');
            fn();
            if (!closing) void finish(1);
          }),
        stop: async () => {
          if (rawChild.exitCode !== null || rawChild.signalCode || spawnError)
            return;
          const ended = new Promise((resolve) =>
            rawChild.once("close", resolve),
          );
          rawChild.kill();
          await Promise.race([
            ended,
            delay(10000).then(() => {
              if (rawChild.exitCode === null && !rawChild.signalCode)
                throw Error("内核未退出，保留 DNS 备份以便恢复");
            }),
          ]);
        },
        get spawnError() {
          return spawnError;
        },
      };
    },
    ready: async (owned) => {
      for (let i = 0; i < 80; i++) {
        if (owned.spawnError) throw owned.spawnError;
        if (rawChild.exitCode !== null || rawChild.signalCode)
          throw Error("内核启动失败，请查看日志");
        try {
          const r = await fetch(
            `http://127.0.0.1:${settings.controllerPort}/version`,
            {
              headers: {
                Authorization: `Bearer ${controllerSecret}`,
              },
              signal: AbortSignal.timeout(500),
            },
          );
          if (r.ok && (await r.json()).version) return;
        } catch {}
        await delay(150);
      }
      throw Error("内核控制接口未就绪，请查看日志");
    },
    applyDns: async () => {
      const adapters = await listAdapters();
      if (!adapters.length) throw Error("未找到可以接管 DNS 的物理网卡");
      const backup = { adapters, ipv6: true, at: new Date().toISOString() };
      writeFileSync(backupPath, JSON.stringify(backup, null, 2));
      await ps(buildApplyScript(true));
      log("DNS 已接管");
    },
    restoreDns,
    onError: (e) => log(`清理失败: ${e.message}`),
  });
  function makeYaml(s, blocked = businessBlocked) {
    const cfg = buildConfig({
      ...s,
      interfaceName: activeInterfaceName || undefined,
      secret: controllerSecret,
      sets: loadRuleSets(join(root, "rules", "domains")),
    });
    lastBuiltDns = structuredClone(cfg.dns);
    // Quote user-provided YAML scalars while retaining the existing serializer.
    for (const p of Object.values(cfg["proxy-providers"]))
      for (const node of p.payload || []) {
        for (const field of ["server", "username", "password"])
          if (typeof node[field] === "string")
            node[field] = JSON.stringify(node[field]);
      }
    // URL 用 JSON.stringify 加引号是给 YAML 序列化器用的; 但同一份 cfg 还要拿去做
    // 信源规则推导(订阅域名直连), 所以先把原始 URL 交给 protected-config, 别让它
    // 看到带引号的版本 —— 否则热重载时订阅域名会从信源规则里消失。
    cfg["proxy-providers"]["airport-sub"].url = JSON.stringify(s.airportUrl);
    cfg.secret = JSON.stringify(controllerSecret);
    return protection ? buildProtectedYaml(cfg, { probePort, probeSecret, businessBlocked: blocked, airportUrl: s.airportUrl }) : configToYaml(cfg);
  }
  let closing = false;
  let finishing;
  const socket = connect(pipe);
  const finish = (code = 0) => {
    if (finishing) return finishing;
    closing = true;
    // A disconnect must wait for (and, on failure, retry) an in-flight explicit
    // stop. `closing` only suppresses the normal child-exit callback.
    finishing = (async () => {
      try {
        await stopProtectedSession({ protection, session, preserve: !intentionalStop, reason: '管理进程断开，保持系统断流' });
      } catch (e) {
        log(`清理失败，备份已保留: ${e.message}`);
        closing = false;
        finishing = null;
        setTimeout(() => void finish(1), 5000);
        return;
      }
      socket.destroy();
      exit(code);
    })();
    return finishing;
  };
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) return void finish(1);
    for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      void (async () => {
        let msg;
        try {
          msg = JSON.parse(line);
          let result = null;
          if (msg.method === "start") {
            settings = msg.payload;
            await session.start(settings.tunEnabled, settings.takeoverDns !== false);
            try { await ordinaryNodes.restore(); }
            catch { log('无法恢复上次普通节点选择，使用内核当前选择'); }
            await protection?.activate(rawChild.pid);
            result = { pid: rawChild.pid };
          } else if (msg.method === 'nodes') {
            if (!session.running) throw Error('请先启动内核');
            result = await ordinaryNodes.read();
          } else if (msg.method === 'selectNode') {
            result = await ordinaryNodes.select(msg.payload);
          } else if (msg.method === 'setTimezone') {
            result = await timezones.set(msg.payload);
          } else if (msg.method === 'restoreTimezone') {
            result = await timezones.restore();
          } else if (msg.method === 'detectTimezone') {
            if (!canSelectNode()) throw Error('请在保护正常且内核运行时识别出口时区');
            const fetchFn = url => residentialFetch(url);
            const ip = await probeTraceIp(fetchFn, 'https://cloudflare-dns.com/cdn-cgi/trace');
            if (!ip) throw Error('无法确认住宅出口 IP，请稍后重试');
            result = await lookupExitTimezone({ fetchFn, expectedIp: ip });
          } else if (msg.method === "stop") {
            if (protection && !msg.payload?.releaseProtection && !msg.payload?.preserveProtection)
              throw Error('实时保护已开启，请明确退出保护或保留断流退出');
            closing = true;
            intentionalStop = true;
            await stopProtectedSession({ protection, session, preserve: !!msg.payload?.preserveProtection, reason: '已退出程序，系统断流仍保留' });
            if (!protection) socket.write(JSON.stringify({ event: 'protection', value: emptyProtection() }) + '\n');
          } else if (msg.method === 'recover') {
            if (session.running || protection) throw Error('内核仍在运行，请先退出当前保护');
            closing = true;
            intentionalStop = true;
            await restoreDns();
            await guard.unlock();
            const state = emptyProtection();
            writeFileSync(join(dataDir, 'protection-state.json'), JSON.stringify(state, null, 2));
            socket.write(JSON.stringify({ event: 'protection', value: state }) + '\n');
          } else if (msg.method === 'resumeProtection') {
            if (!protection || !session.running) throw Error('请先启动实时保护内核');
            result = await protection.resume();
          } else if (msg.method === 'recheck') {
            if (!protection) throw Error('实时保护未启动');
            result = await protection.recheck();
          } else if (msg.method === 'aiRoute') {
            // 手动体检专用的 AI 线路检测: 只读内核状态, 不碰保护状态机。
            if (!session.running) throw Error('内核未运行');
            // mihomo 控制接口的路径由调用方给的是 "/xxx" 形式, controller() 自己拼 "/",
            // 这里去掉开头的斜杠, 避免拼出 "//rules" 这种非规范路径。
            const controllerGet = (path) => controller(String(path).replace(/^\/+/, ''));
            // 实时保护开启时业务端口处于断流状态, 只能走带认证的探测端口;
            // 探测端口固定挂 "AI Guard 专用" 组, 所以探测流量确实走独享 IP。
            //
            // 超时给到 20s: 这条链是"机场前置 -> 住宅 SOCKS5"两跳, 实测量到单次
            // /cdn-cgi/trace 约 2.4s (冷启动更慢)。沿用健康探测的 12s 会让冷启动
            // 那一次超时, 把「Claude 看到的 IP」误报成 unknown —— 而这一项正是
            // 用户最需要确定的那一项。
            const AI_ROUTE_TIMEOUT = 20000;
            const fetchFn = protection
              ? (url) =>
                  proxyFetch(
                    probePort,
                    url,
                    AI_ROUTE_TIMEOUT,
                    'Basic ' + Buffer.from(`aiguard-health:${probeSecret}`).toString('base64'),
                  )
              : (url) => proxyFetch(settings.mixedPort, url, AI_ROUTE_TIMEOUT);
            result = await runAiRouteChecks({
              fetchFn,
              expectedIp: settings.residential?.server ?? '',
              expectedEgressIp: null,
              controllerGet,
            });
          } else if (msg.method === "reload") {
            if (
              !["strict", "precise", "global"].includes(msg.payload) ||
              !session.running
            )
              throw Error("无法切换模式");
            if (protection && protection.snapshot().phase !== 'healthy') throw Error('实时保护检查或断流期间不能切换模式');
            const next = { ...settings, mode: msg.payload };
            await updateConfig(businessBlocked, next);
            if (protection) void protection.monitor.tick('full');
          } else throw Error("未知内核操作");
          socket.write(JSON.stringify({ id: msg.id, result }) + "\n", () => {
            if (msg.method === "stop" || msg.method === 'recover') {
              socket.end();
              exit(0);
            }
          });
        } catch (e) {
          log(`操作失败: ${e.message}`);
          if (msg?.method === "stop") { closing = false; intentionalStop = false; }
          if (socket.destroyed) void finish(1);
          else
            socket.write(
              JSON.stringify({ id: msg?.id, error: e.message }) + "\n",
            );
        }
      })();
    }
  });
  socket.on("close", () => void finish());
  socket.on("error", () => void finish(1));
  process.on("uncaughtException", (e) => {
    log(e.stack || e.message);
    void finish(1);
  });
  process.on("unhandledRejection", (e) => {
    log(String(e));
    void finish(1);
  });
}
