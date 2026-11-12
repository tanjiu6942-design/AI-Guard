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
  /**
   * 恢复自动断流。
   *
   * 一键修复会暂停监控器的自动断流（否则解锁后 15 秒又被重新锁上）。
   * 链路修好后由用户点「恢复自动断流」重新启用。
   */
  async resumeAutoLock() {
    if (this.socket) {
      await this.rpc('resumeAutoLock');
      return;
    }
    // worker 已死：没有监控器在跑，自然也不存在自动断流。
    this.protection = emptyProtection();
    this.onProtection?.(this.protection);
  }

  guardForRecovery() {
    return this.guard || (this.guard = new WindowsGuard({
      executable: join(this.resources, 'guard-filter', 'aiguard-guard-filter.exe'),
      dataDir: this.dataDir,
      elevation: this.elevation,
    }));
  }

  /**
   * 一键修复：软件异常退出后整机断网的紧急自救。
   *
   * 与 recover() 的区别：
   *   - recover() 是「退出保护」的正常路径，失败时抛异常，语义是"停止并复位"
   *   - repairNetwork() 是**救援**路径：不管当前处于什么状态（包括 lock_failed、
   *     worker 已死、状态文件与实际不符），都尽力把 WFP 解除，并把结果结构化
   *     返回给界面，由界面直接展示"修好了/还差什么"
   *
   * 为什么必须存在这个独立入口 —— 现场(2026-11-07)：
   *   block() 的 guard.lock() 成功、configure(true) 超时失败 -> phase: lock_failed。
   *   WFP 4 条 Persistent 规则已生效，配置文件却还是正常态，内核又已退出。
   *   用户面对的是"WiFi 连着、完全没网"，而界面上没有一个明确告诉他
   *   "点这里就能修好"的按钮。
   *
   * 设计要点：
   *   1. **绝不依赖 worker 存活** —— worker 死了正是要救的场景，一律走 UAC 提权
   *   2. 不抛异常，返回 { ok, unlocked, error, native }，让界面如实显示
   *   3. 幂等：本来没锁也返回成功，只是 unlocked=false
   *   4. 清空状态文件，避免下次启动误判「上次断流未解除」
   */
  async repairNetwork() {
    const guard = this.guardForRecovery();
    let native = null;

    /**
     * 第一步：暂停自动断流（如果 worker 还活着）。
     *
     * 顺序很重要 —— 必须**先暂停、再解锁**。
     *
     * 现场(2026-11-11)：用户点「一键修复网络」，WFP 确实解锁了，但住宅 SOCKS5
     * 链路仍然断着(exit=unknown / long=fail)。于是下一轮周期检测照样失败，
     * persistent 判定成立 -> trip() -> 重新 lock() -> 十几秒后又断网。
     * 用户点多少次都没用，体感就是"按钮完全没用"。
     *
     * 解锁与暂停必须成对，缺一不可。
     */
    let suspendedState = null;
    if (this.socket) {
      try {
        suspendedState = await this.rpc('suspendAutoLock');
      } catch (e) {
        // 暂停失败不阻断修复 —— 解锁本身仍然有价值。
        this.log?.(`暂停自动断流失败：${e.message}`);
      }
    }

    // 读真实锁态：WFP 是独立于本进程的内核态对象，只有它说了算。
    try {
      native = await guard.status();
    } catch (e) {
      const error = `无法读取系统防火墙状态：${e.message}`;
      this.protection = { ...emptyProtection(), phase: 'lock_failed', reason: '系统断流仍未解除', error };
      this.onProtection?.(this.protection);
      return { ok: false, unlocked: false, error, native: null };
    }

    let unlocked = false;
    if (native.locked) {
      try {
        // 救援路径一律提权：主进程是 asInvoker，普通权限 unlock 必失败。
        await guard.unlockEscalated();
        unlocked = true;
      } catch (e) {
        const error = `解除系统断流失败：${e.message}`;
        this.protection = { ...emptyProtection(), phase: 'lock_failed', reason: '系统断流仍未解除', error };
        this.onProtection?.(this.protection);
        return { ok: false, unlocked: false, error, native };
      }

      // 不轻信退出码，回读真实状态再确认一次。
      try { native = await guard.status(); } catch { /* 读不到就用解锁前的快照 */ }
      if (native?.locked) {
        const error = '解除系统断流失败：解锁后规则依然生效';
        this.protection = { ...emptyProtection(), phase: 'lock_failed', reason: '系统断流仍未解除', error };
        this.onProtection?.(this.protection);
        return { ok: false, unlocked: false, error, native };
      }
    }

    /**
     * 复位保护状态，但**不动内核的运行状态**。
     *
     * 现场(2026-11-11)：一键修复时内核往往还活着（controllerAvailable:true），
     * 链路只是断了。之前这里无条件设 running=false / corePid=null，
     * 会让界面误报"内核已停止"，用户以为软件没在工作。
     */
    this.error = null;
    this.protection = (this.socket && suspendedState?.phase)
      ? suspendedState
      : emptyProtection();
    try {
      writeFileSync(join(this.dataDir, 'protection-state.json'), JSON.stringify(this.protection, null, 2));
    } catch { /* 状态文件写不了不影响修复结果 */ }
    this.onProtection?.(this.protection);

    return { ok: true, unlocked, error: null, native };
  }
}
