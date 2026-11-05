import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WindowsGuard } from './firewall.mjs';
import { emptyProtection, readProtectionState } from './worker-protection.mjs';

export function needsElevation(settings, dataDir) {
  return (
    settings.tunEnabled || settings.realtimeProtection !== false ||
    existsSync(join(dataDir, "mihomo", "desktop-dns-backup.json"))
  );
}

export class WorkerClient {
  constructor({ executable, args = [], root, cwd = root, dataDir, resources, guard }) {
    Object.assign(this, { executable, args, root, cwd, dataDir, resources, guard });
    this.phase = "stopped";
    this.running = false;
    this.pending = new Map();
    this.seq = 0;
    this.protection = emptyProtection();
  }
  async refreshProtection() {
    if (this.socket) return this.protection;
    const recorded = readProtectionState(this.dataDir);
    try {
      const native = await (this.guard || new WindowsGuard({ executable: join(this.resources, 'guard-filter', 'aiguard-guard-filter.exe'), dataDir: this.dataDir })).status();
      const activeRecord = recorded.phase && recorded.phase !== 'off';
      this.protection = native.locked || activeRecord ? { ...emptyProtection(), ...recorded,
        phase: native.locked && native.complete ? 'locked' : 'lock_failed',
        reason: recorded.reason || '上次保护尚未完成复检，请复检恢复或明确退出保护',
        error: native.locked && native.complete ? null : '系统断流未完整确认，请立即复检或退出保护',
      } : emptyProtection();
    } catch (e) {
      if (recorded.phase && recorded.phase !== 'off') this.protection = { ...recorded, phase: 'lock_failed', error: e.message };
    }
    this.onProtection?.(this.protection);
    return this.protection;
  }
  start(settings, { recovery = false } = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) return Promise.reject(Error("内核正在停止"));
    this.cancelled = false;
    const promise = this.performStart(settings, { recovery });
    this.startPromise = promise;
    const clear = () => {
      if (this.startPromise === promise) this.startPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }
  async performStart(settings, { recovery = false } = {}) {
    if (this.phase === "running") return;
    if (!["stopped", "failed"].includes(this.phase))
      throw Error("内核正在处理上一项操作");
    const elevated = recovery || needsElevation(settings, this.dataDir);
    this.error = null;
    this.phase = elevated ? "elevating" : "starting";
    const pipe = `\\\\.\\pipe\\aiguard-${randomBytes(24).toString("hex")}`;
    try {
      await new Promise((resolve, reject) => {
        const server = (this.server = createServer((socket) => {
          server.close();
          clearTimeout(timer);
          this.cancelConnect = null;
          this.socket = socket;
          let buffer = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk) => {
            buffer += chunk;
            if (buffer.length > 1024 * 1024) return socket.destroy();
            for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              try {
                const msg = JSON.parse(line);
                if (msg.event === 'protection' && msg.value?.phase) {
                  this.protection = msg.value;
                  this.onProtection?.(msg.value);
                  continue;
                }
                const p = this.pending.get(msg.id);
                if (p) {
                  this.pending.delete(msg.id);
                  clearTimeout(p.timer);
                  msg.error
                    ? p.reject(Error(msg.error))
                    : p.resolve(msg.result);
                }
              } catch {
                socket.destroy();
              }
            }
          });
          socket.on("error", () => {});
          socket.on("close", () => {
            if (this.socket !== socket) return;
            const unexpected =
              this.phase !== "stopping" && this.phase !== "stopped";
            this.running = false;
            this.corePid = null;
            this.socket = null;
            this.phase = unexpected ? "failed" : "stopped";
            if (unexpected)
              this.error = "内核管理进程已断开，请检查日志后重新启动";
            if (unexpected && this.protection.phase !== 'off') {
              this.protection = { ...this.protection, phase: 'lock_failed', reason: '管理连接中断，正在保留并确认系统断流', error: this.error };
              this.onProtection?.(this.protection);
              // 管理进程没了, 它留下的"断流中"标记未必还成立。
              // 实测踩过: 界面一直显示"已断流", 但 WFP 实际 filterCount=0(根本没锁)。
              // 用户点"退出保护"也只能靠重启内核去清, 于是退出->重启->再次误判->又断流。
              // 这里主动核对一次真实状态: 既然内核与提权 worker 都不在了,
              // 就以磁盘状态为准复位, 不要让界面撒谎。
              void this.refreshProtection().catch(() => {});
            }
            for (const p of this.pending.values()) {
              clearTimeout(p.timer);
              p.reject(Error("内核管理连接已断开"));
            }
            this.pending.clear();
          });
          resolve();
        }));
        const timer = setTimeout(() => {
          server.close();
          reject(Error("等待内核管理进程超时，请确认 UAC 已允许"));
        }, 90000);
        this.cancelConnect = () => {
          clearTimeout(timer);
          server.close();
          reject(Error("启动已取消"));
        };
        server.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        server.listen(pipe, () => {
          if (this.cancelled) return;
          const args = [
            ...this.args,
            "--aiguard-worker",
            pipe,
            this.dataDir,
            this.resources,
          ];
          if (elevated) {
            const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
            const commandLine = args
              .map(
                (s) =>
                  '"' +
                  s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") +
                  '"',
              )
              .join(" ");
            const script = `try { Start-Process -FilePath ${psQuote(this.executable)} -ArgumentList ${psQuote(commandLine)} -Verb RunAs -WindowStyle Hidden -ErrorAction Stop } catch { Write-Error $_; exit 1 }`;
            execFile(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(script, "utf16le").toString("base64"),
              ],
              { windowsHide: true, timeout: 90000 },
              (e) => {
                if (e) {
                  clearTimeout(timer);
                  server.close();
                  reject(Error("管理员授权被取消或启动失败"));
                }
              },
            );
          } else {
            const env = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            this.child = spawn(this.executable, args, {
              windowsHide: true,
              stdio: "ignore",
              cwd: this.cwd,
              env,
            });
            this.child.once("error", (e) => {
              clearTimeout(timer);
              server.close();
              reject(e);
            });
          }
        });
      });
      this.phase = "starting";
      if (recovery) {
        this.phase = 'stopping';
        const result = await this.rpc('recover');
        this.phase = 'stopped';
        this.running = false;
        const socket = this.socket;
        this.socket = null;
        socket?.end();
        return result;
      }
      const result = await this.rpc("start", settings);
      this.running = true;
      this.phase = "running";
      this.corePid = result.pid;
      return result;
    } catch (e) {
      this.error = this.cancelled ? null : e.message;
      this.phase = this.cancelled ? "stopped" : "failed";
      this.running = false;
      this.socket?.destroy();
      this.server?.close();
      throw e;
    } finally {
      this.cancelConnect = null;
    }
  }
  rpc(method, payload) {
    if (!this.socket) return Promise.reject(Error("内核管理进程未连接"));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("内核操作超时，请检查日志"));
      }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, payload }) + "\n");
    });
  }
  stop(options = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.cancelled = true;
    this.cancelConnect?.();
    const promise = this.performStop(options);
    this.stopPromise = promise;
    const clear = () => {
      if (this.stopPromise === promise) this.stopPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }
  async performStop(options = {}) {
    await this.startPromise?.catch(() => {});
    if (!this.socket) {
      this.running = false;
      this.phase = "stopped";
      return;
    }
    this.phase = "stopping";
    try {
      await this.rpc("stop", options);
      this.running = false;
      this.phase = "stopped";
      this.corePid = null;
      const socket = this.socket;
      this.socket = null;
      socket?.end();
    } catch (e) {
      this.phase = "failed";
      this.error = e.message;
      throw e;
    }
  }
  reload(mode) {
    return this.rpc("reload", mode);
  }
  resumeProtection() { return this.rpc('resumeProtection'); }
  recheck() { return this.rpc('recheck'); }
  aiRoute() { return this.rpc('aiRoute'); }
  nodes() { return this.rpc('nodes'); }
  selectNode(name) { return this.rpc('selectNode', name); }
  detectTimezone() { return this.rpc('detectTimezone'); }
  setTimezone(id) { return this.rpc('setTimezone', id); }
  restoreTimezone() { return this.rpc('restoreTimezone'); }
  /**
   * 退出保护并恢复普通网络。
   *
   * 关键: 内核已退出时**不能重启内核**。
   *
   * 实测踩过的自我循环: 用户点"退出保护" -> 这里发现 socket 已断(内核已退出),
   * 于是走 start(settings, {recovery:true}) 重启内核 -> 新内核启动后立刻做首次完整体检,
   * 而那一刻 TUN 尚未就绪 -> 判 fail -> 又一次整机断流 -> 界面回到"已断流"。
   * 用户点一次按钮, 状态原地踏步, 永远解不开。
   *
   * 正确做法: 内核不在了就只清理本进程的状态(锁标记 / 状态文件),
   * 让界面回到可启动状态; 需要重新联网时用户再点"启动内核"。
   */
  async recover(settings) {
    if (this.socket || this.startPromise) return this.stop({ releaseProtection: true });
    // 内核与提权 worker 都已退出: 本地直接复位, 不重启内核。
    this.running = false;
    this.phase = "stopped";
    this.corePid = null;
    this.error = null;
    this.protection = emptyProtection();
    this.onProtection?.(this.protection);
    return this.protection;
  }
}
