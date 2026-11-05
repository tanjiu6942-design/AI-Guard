import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ProtectionMonitor } from './protection.mjs';
import { createHealthChecker } from './health.mjs';
import { proxyFetch } from './network.mjs';
import { longConnProbe } from './probes.mjs';
import { collectProtectionDiagnostics } from './protection-diagnostics.mjs';

export const emptyProtection = () => ({ phase: 'off', reason: null, error: null, items: [], checkedAt: null, fullCheckedAt: null, lockedAt: null });
export function readProtectionState(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, 'protection-state.json'), 'utf8')); }
  catch { return emptyProtection(); }
}

export class WorkerProtection {
  constructor({ guard, dataDir, settings, configure, controller, emit, probePort, probeSecret, check, log, getDnsConfig }) {
    Object.assign(this, { guard, dataDir, settings, configure, controller, emit, probePort, probeSecret, check, log, getDnsConfig });
    this.state = emptyProtection();
    /**
     * 当前内核配置是否处于"业务流量隔离"态 (rules 头部带 MATCH,REJECT)。
     *
     * undefined = 尚未下发过; true = 隔离态; false = 正常态。
     * 用它避免在已经是正常态时又下发一次同样的配置 ——
     * 每次下发都是一次 PUT /configs 热重载, 会拆建 TUN 网卡与接管路由,
     * 实测这条多余的重载正是"检测全绿后 43 秒突然断流"的根因。
     */
    this.blockedConfig = undefined;
    /** 是否正在用系统级规则隔离 (guard.lock/unlock 的对称跟踪)。 */
    this.guardLocked = undefined;
  }
  publish(state) {
    this.state = state;
    // Persist before notifying, but a storage/display failure must never skip lock().
    try {
      const target = join(this.dataDir, 'protection-state.json');
      writeFileSync(target + '.tmp', JSON.stringify(state, null, 2));
      renameSync(target + '.tmp', target);
    } catch (e) { this.state = { ...state, error: `保护状态保存失败：${e.message}` }; }
    try { this.emit(this.state); } catch { /* IPC loss is handled by the worker. */ }
  }
  snapshot() { return this.monitor?.snapshot() ?? structuredClone(this.state); }
  async prepare(kernelPath) {
    this.kernelPath = kernelPath;
    await this.guard.check();
    const previous = await this.guard.status();
    const recorded = readProtectionState(this.dataDir);
    // 只要 WFP 原生层实际处于锁定状态，就严格保持锁定并等待复检，绝不静默解锁原生断流
    this.wasLocked = previous.locked === true;
    this.previousReason = this.wasLocked ? recorded.reason || '存在尚未解除的系统断流' : null;
    this.publish({ ...emptyProtection(), phase: 'checking', reason: '启动前隔离业务流量' });
    // 隔离只靠 WFP 系统规则, 不改内核配置 —— 启动配置是正常态。
    // 这样检测通过后不需要再下发一次配置(那会热重载并拆建 TUN)。
    await this.guard.lock(kernelPath);
    this.blockedConfig = false;
    this.guardLocked = true;
  }
  async block() {
    const errors = [];
    let confirmed = false;
    try { await this.guard.lock(this.kernelPath); confirmed = true; this.guardLocked = true; } catch (e) { errors.push(e.message); }
    // Capture the pre-reload proxy state after enforcing the system lock.
    try {
      const report = await collectProtectionDiagnostics(this);
      writeFileSync(join(this.dataDir, 'protection-diagnostic.json'), JSON.stringify({ at: new Date().toISOString(), items: this.snapshot().items, ...report }, null, 2));
      this.log?.(`断流诊断: ${JSON.stringify(report)}`);
    } catch { /* Diagnostics must not prevent enforcing the proxy lock. */ }
    try { await this.configure(true, confirmed); this.blockedConfig = true; } catch (e) { errors.push(e.message); }
    try { await this.controller('connections', { method: 'DELETE' }); } catch (e) { errors.push(e.message); }
    if (errors.length) throw Error(errors.join('；'));
  }
  /**
   * 解除隔离: 先摘除系统级断流规则, 再切换回正常业务配置。
   *
   * 顺序不能反。
   *
   * 原来的顺序是 configure(false) -> guard.unlock():
   * configure(false) 是一次 PUT /configs 热重载, 内核会拆掉并重建 TUN 网卡与接管路由;
   * 紧接着 guard.unlock() 要求"过滤器全部移除且状态完整", 而此刻内核正在重建 TUN,
   * guard.status() 读到的是不一致的中间态, 于是 unlock 抛错 ->
   * catch 里又调 block() 重新断流 -> monitor 的 run() 收到异常后 trip()。
   *
   * 实测表现: 检测全部通过后约 43 秒, 界面突然变成"已断流",
   * 触发时间与那次 configure(false) 重载完全重合。
   *
   * 先摘系统规则再切配置:
   *   - guard.unlock() 时配置仍是隔离态(业务流量本来就被 MATCH,REJECT 挡着), 不产生绕过窗口;
   *   - 之后 configure(false) 把业务配置恢复, 此时系统规则已摘除, 不存在"规则没了但配置还写着隔离"的反向空窗。
   */
  /**
   * 解除隔离: 先切回正常业务配置, 再摘除系统级断流规则。
   *
   * 顺序是安全要求: 配置还写着"隔离"时系统规则不能先摘, 否则会出现
   * "规则没了但业务仍按隔离策略走"的反向空窗。
   *
   * 但**每次 configure() 都是一次 PUT /configs 热重载**, 内核会拆掉并重建
   * TUN 网卡与接管路由。首次全量检测要跑 35 秒(30 秒长连接 + 其余探测),
   * 测完全绿后若无条件下发一次, 就会在启动约 43 秒时制造这次重载 ——
   * 实测三次断流的触发时间(00:29:01 / 00:41:49 / 00:52:21)全部精确落在它上面。
   *
   * 所以: 配置本来就不是隔离态时, 跳过这次多余的重载。
   */
  async unblock(valid = () => true) {
    try {
      if (!valid()) throw Error('恢复已被新的异常取消');
      if (this.blockedConfig !== false) {
        await this.configure(false);
        this.blockedConfig = false;
        if (!valid()) throw Error('恢复已被新的异常取消');
      }
      // 只要隔离过就摘除系统规则 —— 用自己跟踪的状态, 不依赖 guard.status()
      // (后者在 fixture / 部分实现下可能不反映真实锁态)。
      if (this.guardLocked !== false) {
        await this.guard.unlock();
        this.guardLocked = false;
        if (!valid()) throw Error('恢复已被新的异常取消');
      }
    } catch (e) {
      // Never leave the local proxy as a bypass when removing system rules failed.
      await this.block().catch(() => {});
      throw e;
    }
  }
  async activate(corePid) {
    const authorization = 'Basic ' + Buffer.from(`aiguard-health:${this.probeSecret}`).toString('base64');
    // 监控器先建, 再把宽限期判定交给体检器 —— 两者共用同一个时钟源。
    const monitor = new ProtectionMonitor({
      lock: () => this.block(), unlock: valid => this.unblock(valid), notify: state => this.publish(state),
      autoReconnect: this.settings?.autoReconnect !== false,
    });
    this.monitor = monitor;
    const health = this.check || createHealthChecker({
      settings: this.settings, controller: this.controller, probePort: this.probePort, corePid,
      getDnsConfig: this.getDnsConfig,
      fetchFn: url => proxyFetch(this.probePort, url, 12000, authorization),
      long: longConnProbe(this.probePort, 30000, 10000, authorization),
      // 启动宽限期内 TUN/IPv6 未就绪判 unknown, 不当作泄漏
      inStartupGrace: () => monitor.inStartupGrace(),
    });
    /**
     * 把每一轮检测的原始结果与结论写进日志。
     *
     * 没有这层记录时, 断流只留在界面文案里(而且很快被后续状态覆盖),
     * 事后只能靠内核日志反推, 排查成本极高 —— 实测为此反复误判了多轮。
     * 现在 pendingStates 里带出每一项的 state/detail, 以及最终是否 trip。
     */
    monitor.check = async (kind) => {
      const items = await health(kind);
      try {
        const brief = items.map(x => `${x.key}=${x.state}${x.critical ? '!' : ''}`).join(' ');
        const bad = items.filter(x => x.state !== 'ok');
        this.log?.(`检测[${kind}] ${brief}` + (bad.length ? ` | 非ok: ${bad.map(x => `${x.title}(${x.state}): ${x.detail}`).join(' ; ')}` : ' | 全部通过'));
      } catch { /* 日志失败不得影响检测 */ }
      return items;
    };
    await monitor.start({ locked: this.wasLocked, reason: this.previousReason });
  }
  /** 配置热重载后重新开启宽限期, 避免重建 TUN 的空窗被误判为接管失效。 */
  notifyReload() {
    this.monitor?.markReload();
  }
  async trip(reason) {
    // 断流原因必须落日志。否则只能从界面文案事后反推, 而文案很快会被后续状态覆盖,
    // 实测为此反复误判了多轮。这行是排查断流的唯一可靠锚点。
    try { this.log?.(`触发断流: ${reason}`); } catch { /* 日志失败不得阻断断流 */ }
    if (this.monitor) return this.monitor.trip(reason);
    try {
      await this.guard.lock(this.kernelPath);
      this.publish({ ...this.state, phase: 'locked', reason, lockedAt: new Date().toISOString() });
    } catch (e) { this.publish({ ...this.state, phase: 'lock_failed', reason, error: e.message }); }
    return this.snapshot();
  }
  resume() {
    if (!this.monitor) throw Error('请先启动内核，再复检恢复');
    return this.monitor.resume();
  }
  async recheck() {
    if (!this.monitor) throw Error('实时监测未启动');
    await this.monitor.tick('full');
    return this.monitor.snapshot().items;
  }
  async shutdown() { await this.monitor?.shutdown(); }
  async assertSystemLocked() {
    const state = await this.guard.status();
    if (!state.locked || state.complete !== true)
      throw Error('系统断流尚未完整生效，保留内核与监测，请重试或明确退出保护');
  }
  async release() {
    await this.shutdown();
    await this.guard.unlock();
    this.publish(emptyProtection());
  }
}
