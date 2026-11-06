import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
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
  constructor({ executable, args = [], root, cwd = root, dataDir, resources, guard, elevation }) {
    Object.assign(this, { executable, args, root, cwd, dataDir, resources, guard, elevation });
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
   * 但"不重启内核"不等于"不需要解除锁定" —— 这两件事曾被混为一谈,
   * 直接造成了 2026-11-06 的事故: 内核与 worker 都已退出, WFP 里 4 条
   * Persistent 规则仍然生效(filterCount=4), 而这里只把内存状态刷成 off,
   * 界面显示"已恢复"、网络却全断。用户点了很多次都无效, 最后只能还原系统。
   *
   * 所以: worker 活着 -> 由 worker 执行 unlock; worker 死了 ->
   * **主进程自己直接调 guard 解除 WFP**, 不依赖任何已退出的进程。
   */
  async recover(settings, { resetOnly = false } = {}) {
    if (this.socket || this.startPromise) return this.stop({ releaseProtection: true });
    const guard = this.guardForRecovery();
    if (!resetOnly) {
      // 先读真实锁态: WFP 是独立于本进程的内核态对象, 只有它说了算。
      let native;
      try { native = await guard.status(); }
      catch (e) {
        // 读不到真实状态就不能谎称已恢复。
        this.protection = { ...emptyProtection(), phase: 'lock_failed', error: `无法确认系统断流状态：${e.message}` };
        this.onProtection?.(this.protection);
        throw Error(`无法确认系统断流状态：${e.message}`);
      }
      if (native.locked) {
        try {
          /**
           * worker 活着 -> 它本身就是提权进程，直接 unlock 不弹 UAC。
           * worker 已死  -> 主进程是 asInvoker，必须经 UAC 提权才能解除
           *                 （实测普通权限 unlock 直接 exit 1）。
           */
          if (this.socket) await guard.unlock();
          else await guard.unlockEscalated();
        }
        catch (e) {
          // 解锁失败必须把"仍锁着"如实反映到界面, 并抛给调用方。
          this.protection = { ...emptyProtection(), phase: 'lock_failed', reason: '系统断流仍未解除', error: e.message };
          this.onProtection?.(this.protection);
          throw Error(`解除系统断流失败：${e.message}`);
        }
        // unlock 内部会回读 status 校验, 这里再确认一次, 避免"以为解了其实没解"。
        const after = await guard.status();
        if (after.locked) {
          this.protection = { ...emptyProtection(), phase: 'lock_failed', reason: '系统断流仍未解除', error: '解锁后系统断流依然生效' };
          this.onProtection?.(this.protection);
          throw Error('解除系统断流失败：解锁后系统断流依然生效');
        }
      }
    }
    // 内核与提权 worker 都已退出: 本地直接复位, 不重启内核。
    this.running = false;
    this.phase = "stopped";
    this.corePid = null;
    this.error = null;
    this.protection = emptyProtection();
    try {
      writeFileSync(join(this.dataDir, 'protection-state.json'), JSON.stringify(this.protection, null, 2));
    } catch { /* 状态文件写不了不影响解锁结果 */ }
    this.onProtection?.(this.protection);
    return this.protection;
  }
  guardForRecovery() {
    return this.guard || (this.guard = new WindowsGuard({
      executable: join(this.resources, 'guard-filter', 'aiguard-guard-filter.exe'),
      dataDir: this.dataDir,
      elevation: this.elevation,
    }));
  }
}
