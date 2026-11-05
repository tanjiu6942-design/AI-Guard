// The privileged worker owns this state; renderer polling never drives safety.

/**
 * 启动宽限期(ms): 内核启动后这段时间内, TUN 接管与 IPv6 隧道地址的缺失
 * 视为"尚未建立"而不是"泄漏"。
 *
 * 实测: 内核监听端口比 TUN 网卡 up 早约 855ms(23:37:59.967 vs 23:38:00.822),
 * IPv4/IPv6 接管路由建立得更晚。首次完整体检若在此之前跑, 必然读不到接管状态,
 * 判 fail 会让"刚启动"被当成"泄漏"而立刻整机断流。
 *
 * 取 30s: 足够覆盖 TUN 建立 + 路由接管 + 首个探测端点往返(实测约 8s),
 * 又不至于长到掩盖真实的接管失效。宽限期结束后仍不接管照样判 fail 并断流。
 */
export const STARTUP_GRACE_MS = 30000;

export class ProtectionMonitor {
  constructor({ check, lock, unlock, notify = () => {}, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { check, lock, unlock, notify, now, schedule, cancel });
    this.state = { phase: 'off', reason: null, error: null, checkedAt: null,
      fullCheckedAt: null, lockedAt: null, items: [] };
    this.generation = 0;
    this.flights = new Map();
    this.failures = new Map();
    this.retry = new Set();
    this.samples = new Map();
    this.effects = Promise.resolve();
  }
  snapshot() { return structuredClone(this.state); }
  emit(patch = {}) {
    Object.assign(this.state, patch);
    try { this.notify(this.snapshot()); } catch (e) { this.state.error = `状态提示失败：${e.message}`; }
  }
  iso() { return new Date(this.now()).toISOString(); }
  effect(fn) {
    const task = this.effects.then(fn);
    this.effects = task.catch(() => {});
    return task;
  }
  async start({ locked = false, reason = null } = {}) {
    this.active = true;
    this.nextExit = this.now() + 15000;
    this.nextFull = this.now() + 60000;
    // 启动宽限期从此刻起算, 期间 TUN/IPv6 未就绪判 unknown 而非 fail
    this.graceUntil = this.now() + STARTUP_GRACE_MS;
    // 是否曾经真正锁定过。用于区分两种"仍然隔离":
    //   - 启动阶段的隔离是保护的正常流程(显示"检查中");
    //   - 已经锁定过之后的复检(显示"已断流")。
    this.everLocked = locked;
    if (locked) this.emit({ phase: 'locked', reason: reason || '上次异常断流尚未解除', lockedAt: this.iso() });
    else {
      this.emit({ phase: 'checking', reason: '启动检查中，业务流量暂时阻断' });
      await this.run('full', true);
    }
    this.arm();
    return this.snapshot();
  }
  /**
   * 是否仍处于启动宽限期。
   *
   * 供 createHealthChecker 的 inStartupGrace 回调使用: 宽限期内把
   * "TUN 接管 / IPv6 防泄漏" 的 fail 降级为 unknown, 避免刚启动就整机断流。
   */
  inStartupGrace() {
    return this.active && this.graceUntil > this.now();
  }
  /**
   * 配置热重载: 重新开启宽限期。
   *
   * 每次 PUT /configs 都会重新下发 tun 配置, 内核会拆掉再重建 TUN 网卡与接管路由。
   * 重建窗口内 Get-NetAdapter 读不到 Meta、路由也不归 Meta 所有 ——
   * 此时判 fail 会立刻整机断流, 而实测触发时间与重载时刻完全重合
   * (00:41:49 重载 -> 00:41:49 断流)。
   *
   * 宽限期只把 fail 降级为 unknown(无法确认), 不会谎称安全:
   * 重载窗口过后仍不接管照样判 fail 并断流。
   */
  markReload() {
    this.graceUntil = this.now() + STARTUP_GRACE_MS;
  }
  arm() {
    if (!this.active) return;
    this.timer = this.schedule(() => {
      if (!this.active) return;
      if (this.state.phase === 'lock_failed') void this.trip(this.state.reason);
      else if (['healthy', 'suspect', 'checking'].includes(this.state.phase)) {
        void this.tick('local');
        if (this.retry.has('full') || this.now() >= this.nextFull) {
          this.nextFull = this.now() + 60000;
          void this.tick('full');
        } else if (this.retry.has('exit') || this.now() >= this.nextExit) {
          this.nextExit = this.now() + 15000;
          void this.tick('exit');
        }
      }
      this.arm();
    }, 5000);
    this.timer?.unref?.();
  }
  tick(kind, release = false) {
    if (!this.active) return Promise.resolve(this.snapshot());
    if (this.state.phase === 'checking' && kind !== 'full') return Promise.resolve(this.snapshot());
    const allowed = ['healthy', 'suspect', 'checking'].includes(this.state.phase);
    if (!allowed) return Promise.resolve(this.snapshot());
    const lane = kind === 'local' ? 'local' : 'network';
    if (this.flights.has(lane)) return this.flights.get(lane);
    const startupRelease = this.state.phase === 'checking' && kind === 'full';
    const task = this.run(kind, startupRelease);
    this.flights.set(lane, task);
    task.finally(() => { if (this.flights.get(lane) === task) this.flights.delete(lane); });
    return task;
  }
  async collect(kind) {
    let timer;
    try {
      const items = await Promise.race([
        this.check(kind),
        new Promise((_resolve, reject) => {
          timer = this.schedule(() => reject(Error('检测超过截止时间')), kind === 'full' ? 45000 : 20000);
        }),
      ]);
      if (!Array.isArray(items) || !items.length) throw Error('检测没有返回有效项目');
      return items;
    } catch (e) {
      return [{ key: `collection-${kind}`, title: '检测能力', state: 'unknown', detail: e.message, critical: false }];
    } finally { this.cancel(timer); }
  }
  merge(items, sampledAt) {
    const current = new Map(this.state.items.map(x => [x.key, x]));
    const accepted = [];
    for (const item of items) {
      if ((this.samples.get(item.key) ?? -1) > sampledAt) continue;
      this.samples.set(item.key, sampledAt);
      const value = { ...item, checkedAt: this.iso() };
      current.set(item.key, value);
      accepted.push(value);
    }
    this.state.items = [...current.values()];
    return accepted;
  }
  async run(kind, release = false) {
    const token = this.generation;
    const sampledAt = this.now();
    const collected = await this.collect(kind);
    if (!this.active || token !== this.generation) return this.snapshot();
    // A successful collection supersedes an earlier failure to collect this lane.
    if (!collected.some(x => x.key === `collection-${kind}`)) {
      this.state.items = this.state.items.filter(x => x.key !== `collection-${kind}`);
      this.failures.delete(`collection-${kind}`);
    }
    if (release) { this.state.items = []; this.samples.clear(); }
    const accepted = this.merge(collected, sampledAt);
    this.state.checkedAt = this.iso();
    if (kind === 'full') this.state.fullCheckedAt = this.iso();
    const abnormal = accepted.filter(x => x.state !== 'ok');
    const collectionFailed = collected.some(x => x.key === `collection-${kind}`);
    const actionable = abnormal;
    if (abnormal.length) {
      const reason = abnormal.map(x => `${x.title}：${x.detail}`).join('；');
      const repeatFail = actionable.some(x => x.critical || this.failures.has(x.key));
      // The controller can answer before mihomo finishes loading providers.
      // Keep startup quarantine and retry connectivity failures during grace;
      // confirmed leaks, collection errors and manual recovery still fail closed.
      const hasCriticalLeak = abnormal.some(x => x.critical);
      if (release && (this.everLocked || collectionFailed || hasCriticalLeak || !this.inStartupGrace())) return this.trip(reason);
      if (!release && repeatFail) return this.trip(reason);
      for (const item of actionable) this.failures.set(item.key, true);
      this.retry.add(kind);
      if (release) {
        if (!this.everLocked && !collectionFailed && this.inStartupGrace()) {
          this.emit({ phase: 'checking', reason: '启动检查中，业务流量暂时阻断', error: null });
        } else {
          return this.trip(reason);
        }
      } else {
        this.emit({ phase: 'suspect', reason, error: null });
      }
      return this.snapshot();
    }
    this.retry.delete(kind);
    for (const item of accepted) this.failures.delete(item.key);
    if (release) {
      try {
        const valid = () => this.active && token === this.generation;
        await this.effect(async () => {
          if (!valid()) return;
          await this.unlock(valid);
          if (!valid()) await this.lock();
        });
        if (!this.active || token !== this.generation) return this.snapshot();
        this.failures.clear();
        this.retry.clear();
        this.emit({ phase: 'healthy', reason: null, error: null, lockedAt: null });
      } catch (e) { return this.trip(`恢复失败：${e.message}`); }
    } else if (this.state.phase !== 'checking' && !this.failures.size && this.state.items.every(x => x.state === 'ok')) this.emit({ phase: 'healthy', reason: null, error: null });
    else this.emit();
    return this.snapshot();
  }
  trip(reason = '检测异常') {
    if (this.tripPromise) return this.tripPromise;
    ++this.generation;
    // 真正锁定过一次: 之后的复检显示"已断流"而不是"检查中"
    this.everLocked = true;
    this.emit({ phase: 'locking', reason, error: null });
    const task = (async () => {
      try {
        await this.effect(() => this.lock());
        this.emit({ phase: 'locked', lockedAt: this.state.lockedAt || this.iso(), error: null });
      } catch (e) { this.emit({ phase: 'lock_failed', error: e.message }); }
      return this.snapshot();
    })();
    this.tripPromise = task;
    task.finally(() => { if (this.tripPromise === task) this.tripPromise = null; });
    return task;
  }
  resume() {
    if (this.resumePromise) return this.resumePromise;
    if (!this.active || !['locked', 'lock_failed'].includes(this.state.phase)) return Promise.reject(Error('当前没有待恢复的断流锁定'));
    const task = (async () => {
      await this.tripPromise;
      ++this.generation;
      this.emit({ phase: 'recovering', error: null });
      await this.run('full', true);
      return this.snapshot();
    })();
    this.resumePromise = task;
    task.finally(() => { if (this.resumePromise === task) this.resumePromise = null; });
    return task;
  }
  async shutdown() {
    this.active = false;
    ++this.generation;
    this.cancel(this.timer);
    await Promise.allSettled([...this.flights.values(), this.tripPromise, this.resumePromise].filter(Boolean));
    await this.effects;
  }
}
