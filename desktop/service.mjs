import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadSettings, saveSettings } from "../dist/core/settings.js";
import { loadRuleSets } from "../dist/core/domain/rule-source.js";
import { analyzeLog } from "../dist/core/domain/patcher.js";
import { runDoctor } from "../dist/core/doctor/index.js";
import { validateSettings, requireConnection } from "./settings.mjs";
import { ensureNetworkReady } from "./preflight.mjs";
import { proxyFetch } from "./network.mjs";
import * as probes from "./probes.mjs";
import { TimezoneManager } from './timezone.mjs';

export class DesktopService {
  constructor({ dataDir, root, worker }) {
    this.dataDir = dataDir;
    this.root = root;
    this.worker = worker;
    this.settingsPath = join(dataDir, "settings.json");
    this.exit = { exitIp: null, exitCountry: null };
    this.nextProbe = 0;
    mkdirSync(dataDir, { recursive: true });
    this.timezones = new TimezoneManager({ dataDir });
  }
  settings() {
    return loadSettings(this.settingsPath);
  }
  /**
   * 本机是否被 AI Guard 自己的 WFP 规则锁着。
   *
   * `status` 子命令不需要管理员权限(native/GuardFilter/Program.cs 明确只对
   * lock/unlock/check 要求提权), 所以启动前的这道判定不额外弹 UAC。
   * 任何异常都按"没锁"处理 —— 前置门保持原有的保守行为, 不因此更宽松。
   */
  async selfLocked() {
    try {
      const state = await this.worker.guardForRecovery().status();
      return state.locked === true;
    } catch {
      return false;
    }
  }
  /**
   * AI 线路检测的 4 项(独享 IP / 断网保护 / Claude Code 线路 / Claude 看到的 IP)。
   *
   * 必须由提权 worker 计算: 实时保护开启时 mihomo 控制接口的 secret 被换成随机值,
   * 主进程拿不到。这 4 项只做手动体检, 不进入周期监控 —— 它们依赖 claude.ai 的
   * 外部可达性和进程瞬时状态, 拿来做断流判据会在第二轮就误触发整机断流。
   */
  async aiRouteItems() {
    try {
      const items = await this.worker.aiRoute();
      return Array.isArray(items) ? items : [];
    } catch (e) {
      return [{
        key: 'ai-route-unavailable',
        title: 'AI 线路检测',
        state: 'unknown',
        detail: `AI 线路检测不可用：${e.message}`,
      }];
    }
  }
  logs(n = 150) {
    const path = join(this.dataDir, "mihomo", "desktop.log");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split(/\r?\n/)
          .slice(-Math.min(1000, Math.max(1, Number(n) || 150)))
      : [];
  }
  async call(method, payload) {
    const s = this.settings();
    switch (method) {
      case "settings":
        return s;
      case 'timezone':
        return this.timezones.status();
      case 'setTimezone':
        return this.worker.running ? this.worker.setTimezone(payload) : this.timezones.set(payload);
      case 'restoreTimezone':
        return this.worker.running ? this.worker.restoreTimezone() : this.timezones.restore();
      case 'nodes':
        if (!this.worker.running) throw Error('请先启动内核');
        return this.worker.nodes();
      case 'selectNode':
      case 'detectTimezone':
        if (!this.worker.running || (this.worker.protection && !['off', 'healthy'].includes(this.worker.protection.phase)))
          throw Error('请在保护正常且内核运行时操作');
        return method === 'selectNode' ? this.worker.selectNode(payload) : this.worker.detectTimezone();
      case "saveSettings": {
        if (
          this.worker.running ||
          !["stopped", "failed"].includes(this.worker.phase) ||
          (this.worker.protection && this.worker.protection.phase !== 'off')
        )
          throw Error("请先停止内核，再修改连接配置");
        const validated = validateSettings(payload);
        if (!validated.secret)
          validated.secret = randomBytes(24).toString("hex");
        saveSettings(this.settingsPath, validated);
        return validated;
      }
      case "status": {
        if (!this.worker.running)
          this.exit = { exitIp: null, exitCountry: null };
        else if (Date.now() > this.nextProbe) {
          this.nextProbe = Date.now() + 30000;
          void proxyFetch(
            s.mixedPort,
            "https://cloudflare-dns.com/cdn-cgi/trace",
          )
            .then(async (r) => {
              if (!r.ok || !this.worker.running) return;
              const text = await r.text();
              this.exit = {
                exitIp: /^ip=(.+)$/m.exec(text)?.[1]?.trim() ?? null,
                exitCountry: /^loc=(.+)$/m.exec(text)?.[1]?.trim() ?? null,
              };
            })
            .catch(() => {
              this.exit = { exitIp: null, exitCountry: null };
            });
        }
        return {
          running: this.worker.running,
          phase: this.worker.phase,
          error: this.worker.error ?? null,
          mode: s.mode,
          tunEnabled: s.tunEnabled,
          mixedPort: s.mixedPort,
          ...this.exit,
          protection: this.worker.protection,
        };
      }
      case "start":
        requireConnection(s);
        // 在提权之前拦住未认证网络：见 preflight.mjs 顶部注释里那条死锁。
        // 但若本机被本软件自己的 WFP 规则锁着，前置门必须让路 ——
        // 否则「要解锁必须先启动、要启动必须先出网、要出网必须先解锁」——
        // 用户会被彻底锁死(实测 2026-11-06 只能还原系统)。
        await ensureNetworkReady({ selfLocked: await this.selfLocked() });
        this.nextProbe = 0;
        return this.worker.start(s);
      case "stop":
        if (this.worker.protection && this.worker.protection.phase !== 'off')
          throw Error('实时保护正在运行，请使用退出保护或复检恢复');
        return this.worker.stop();
      case 'resumeProtection':
        if (!this.worker.running) {
          requireConnection(s);
          if (s.realtimeProtection === false) throw Error('请先退出遗留断流，再启用实时保护与 TUN');
          // 与 start 同理：本机被自己的 WFP 规则锁着时，裸网探测必然全部失败，
          // 前置门必须让路，否则「要解锁必须先出网」的死锁会在这里重演。
          await ensureNetworkReady({ selfLocked: await this.selfLocked() });
          await this.worker.start(s);
        }
        return this.worker.resumeProtection();
      case 'releaseProtection':
        return this.worker.recover(s);
      case 'shutdown':
        // 正常退出程序: 释放保护, 不保留断流。
        //
        // 原来传 preserveProtection: true, 于是每次关闭程序都走
        // stopProtectedSession -> trip() -> 把状态写成 "locked"。
        // 但 trip() 里装 WFP 过滤器的步骤在退出流程里经常来不及完成,
        // 结果就是"状态说已断流、WFP filterCount=0、网络其实是通的"。
        // 用户下次打开软件立刻看到"已断流", 以为出了问题。
        //
        // 强杀/崩溃场景另有保护: worker 管道断开时 finish() 会以
        // preserve=true 收尾, 那种情况才需要保留断流。
        return this.worker.stop();
      case "setMode": {
        if (this.worker.protection && !['off', 'healthy'].includes(this.worker.protection.phase))
          throw Error('保护检查或断流期间不能切换模式');
        const next = validateSettings({ ...s, mode: payload });
        if (this.worker.running) await this.worker.reload(next.mode);
        saveSettings(this.settingsPath, next);
        return next.mode;
      }
      case "logs":
        return this.logs(payload);
      case "scan": {
        const domains = Object.values(
          loadRuleSets(join(this.root, "rules", "domains")),
        )
          .flat()
          .map((r) => r.split(",")[1]);
        return analyzeLog(this.logs(1000).join("\n"), domains);
      }
      case "doctor": {
        if (!this.worker.running) throw Error("请先启动内核，再运行网络体检");
        if (this.worker.protection && this.worker.protection.phase !== 'off') {
          if (!['healthy', 'suspect'].includes(this.worker.protection.phase))
            throw Error('已锁定或正在检查，请使用复检并恢复');
          const items = await this.worker.recheck();
          return [...items, ...(await this.aiRouteItems())];
        }
        const fetchFn = (url) => proxyFetch(s.mixedPort, url);
        const [observed, networkOk] = await Promise.all([
          probes.stunProbe(),
          fetchFn("https://cloudflare-dns.com/cdn-cgi/trace")
            .then((r) => r.ok)
            .catch(() => false),
        ]);
        const report = await runDoctor({
          fetchFn,
          expectedIp: /^\d+\.\d+\.\d+\.\d+$/.test(s.residential.server)
            ? s.residential.server
            : "",
          expectedCountry: process.env.AIGUARD_EXPECTED_COUNTRY || "US",
          hasIpv6: probes.hasPublicIpv6(),
          webrtcObserved: observed,
          networkOk,
          tunEnabled: s.tunEnabled,
          longConnProbe: probes.longConnProbe(s.mixedPort, 30000),
          idleMs: 30000,
          processLister: probes.listProcesses,
          ownPids: this.worker.corePid ? [this.worker.corePid] : [],
          readDnsServers: probes.readDnsServers,
          dnsHijackProbe: probes.dnsHijackProbe,
          ipv6Snapshot: probes.readIpv6Snapshot,
        });
        return [...report.items, ...(await this.aiRouteItems())];
      }
      default:
        throw Error("未知桌面操作");
    }
  }
}
