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
    schedule = setTimeout, cancel = clearTimeout, autoReconnect = false }) {
    Object.assign(this, { check, lock, unlock, notify, now, schedule, cancel, autoReconnect });
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
    // Startup isolation survives an inconclusive check, even if phase is suspect.
    // Only a successful full check followed by unlock may clear it.
    this.releasePending = true;
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
      /**
       * `lock_failed` 不再自动重试。
       *
       * 原来这里是 `void this.trip(this.state.reason)`，而 trip() 又会去 lock()。
       * lock 持续失败时（WFP 拒绝 / 权限不足 / helper 缺失）状态永远停在
       * lock_failed，于是每 15 秒重试一次，无限循环。
       * 实测 2 分钟内重试 8 次；昨夜(2026-11-06) 的 protection-state.json
       * 正停在 lock_failed，与该循环吻合。
       *
       * 重复失败不会因为多试几次就成功，只会把一次失败放大成持续的后台噪音。
       * 正确做法：如实保留 lock_failed，等用户修好原因后手动复检。
       */
      if (this.state.phase === 'lock_failed') {
        // 保持状态，不重试；下面的 arm() 仍会续期，以便用户在修好原因后
        // 通过 resume()/手动复检继续，而这不需要后台轮询。
      } else if (this.state.phase === 'locked') {
        if (this.autoReconnect && !this.resumePromise && !this.tripPromise && this.now() >= (this.nextResume ?? 0)) {
          this.nextResume = this.now() + 15000;
          void this.resume().catch(() => {});
        }
      } else if (['healthy', 'suspect', 'checking'].includes(this.state.phase)) {
        void this.tick('local');
        /*
         * 自适应降频：自测本身要占用住宅 SOCKS5 通道。
         * full 检测含一条 30 秒长连接 + 3 个出口 trace，全部走住宅链路 ——
         * 固定 60 秒一次等于这条跨境通道有一半时间被自测占着，
         * 业务连接只能排队甚至被服务端重置。
         * 因此：链路健康时拉长间隔省出通道，一旦有异常立刻回到高频以便尽快确认。
         */
        const healthy = this.failures.size === 0;
        if (this.retry.has('full') || this.now() >= this.nextFull) {
          this.nextFull = this.now() + (healthy ? 180000 : 60000);
          void this.tick('full');
        } else if (this.retry.has('exit') || this.now() >= this.nextExit) {
          this.nextExit = this.now() + (healthy ? 45000 : 15000);
          void this.tick('exit');
        }
      }
      this.arm();
    }, 15000);
    this.timer?.unref?.();
  }
  tick(kind, release = false) {
    if (!this.active) return Promise.resolve(this.snapshot());
    if (this.releasePending && kind !== 'full') return Promise.resolve(this.snapshot());
    const allowed = ['healthy', 'suspect', 'checking'].includes(this.state.phase);
    if (!allowed) return Promise.resolve(this.snapshot());
    const lane = kind === 'local' ? 'local' : 'network';
    if (this.flights.has(lane)) return this.flights.get(lane);
    const startupRelease = this.releasePending && kind === 'full';
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
          timer = this.schedule(() => {
            /**
             * 超时是**测量**问题, 不是安全判定。
             *
             * full 检测含一条 30 秒长连接 + 3 个出口 trace, 全部要过跨境住宅隧道
             * (实测单连接排队可达 10 秒)。45 秒硬超时很容易在链路拥塞时踩中。
             * 现场(2026-11-06 07:04): 三个探针全部 i/o timeout -> 这里超时
             * -> 曾据此立即整机断流 -> 内核随后退出 -> 除死内核外全被挡死。
             *
             * 所以超时标 `timedOut`, 由调用方区别对待: 它不是"确认不安全"。
             */
            const e = Error('检测超过截止时间');
            e.timedOut = true;
            reject(e);
          }, kind === 'full' ? 45000 : 20000);
        }),
      ]);
      if (!Array.isArray(items) || !items.length) throw Error('检测没有返回有效项目');
      return items;
    } catch (e) {
      return [{
        key: `collection-${kind}`, title: '检测能力', state: 'unknown',
        detail: e.message,
        // 读不到本机状态(权限被拒/异常抛出)无法证明安全 -> 立即 fail-closed。
        // 只是探测超时则不算确认泄漏, 与 unknown 同等待遇: 连续两轮才锁。
        critical: false,
        timedOut: e.timedOut === true,
      }];
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
    // Reset each recovered item independently, including mixed-result rounds.
    // Items absent from this sample retain their unresolved failure history.
    for (const item of accepted) {
      if (item.state === 'ok') this.failures.delete(item.key);
    }
    const collectionFailed = collected.some(x => x.key === `collection-${kind}`);
    const actionable = abnormal;
    if (abnormal.length) {
      const reason = abnormal.map(x => `${x.title}：${x.detail}`).join('；');
      /**
       * 分级处置，只有「确认泄漏」才立即断流：
       *
       * - critical（出口改变 / 观察到不一致出口 / 网卡 DNS 泄漏）：任何阶段立刻 fail-closed
       * - collectionFailed（连本机状态都读不到）：无法证明安全，立刻 fail-closed
       * - 其余（出口探测端点全部无响应 unknown、长连接抖动 fail）都属于「无法判断」
       *   或链路质量，不是泄漏。住宅 SOCKS5 跨境链路并发高时单连接排队可达 10 秒级，
       *   把排队误判成泄漏会造成反复误断流。这类异常要**连续两轮**仍然如此才断流
       *   （第二轮即 failures 计数 >= 1，见下方 persistent 判定）。
       *
       * 计数放在 failures 里，成功一轮即清零，避免"断过一次就永久过敏"。
       */
      const hasCriticalLeak = abnormal.some(x => x.critical);
      /**
       * 区分三种「无法继续」的程度, 只有真正确认的两类才立即 fail-closed:
       *
       * 1. critical        —— 观察到泄漏/出口改变。立即锁, 无争议。
       * 2. 读不到本机状态    —— 权限被拒、检测崩溃。无法证明安全, 立即锁。
       * 3. 只是探测超时      —— 跨境链路排队/抖动。**不立即锁**: 这是测量问题。
       *    现场(2026-11-06 07:04)三个探针全部 i/o timeout -> 45 秒硬超时
       *    -> 曾据此立即整机断流 -> 内核随后退出 -> 除死掉的内核外所有应用
       *    被 WFP 挡死, 用户只能还原系统。链路抖动不该升级成整机断网。
       *    它仍受 fail-closed 约束: 连续两轮仍超时照样锁(见下方 persistent)。
       */
      const hardFailure = collected.some(x => x.key?.startsWith('collection-') && !x.timedOut);
      if (hasCriticalLeak || hardFailure) return this.trip(reason);
      // 连续第 2 轮仍异常。刻意不因 unknown 而放宽：连续 unknown 必须锁死，
      // 否则只要阻断探测端点就能让「出口一致性」永远无法判断，形成 fail-open
      // （见 source-bypass 契约）。真正要治的是 unknown 的成因 —— 住宅链路连接被
      // 重置、前置节点抖动、探针超时过紧，这些都在健康探测侧修，而不是放宽判定。
      const persistent = abnormal.some(x => (this.failures.get(x.key) ?? 0) >= 1);
      if (!release) {
        // 运行期周期检测：不受启动宽限期约束，连续两轮即锁
        if (persistent) return this.trip(reason);
      } else if (this.everLocked || (!this.inStartupGrace() && persistent)) {
        // 启动首检 / 断流后复检：宽限期外才锁；已锁定过的复检不通过就继续保持锁定
        return this.trip(reason);
      }
      for (const item of actionable) this.failures.set(item.key, (this.failures.get(item.key) ?? 0) + 1);
      this.retry.add(kind);
      if (release) {
        if (!this.everLocked && this.inStartupGrace()) {
          this.emit({ phase: 'checking', reason: '启动检查中，业务流量暂时阻断', error: null });
        } else if (this.state.phase === 'recovering') {
          // 复检未通过：保持锁定（安全语义不变），交给自动复联周期重试，不重复粗暴断流
          this.emit({ phase: 'locked', reason, error: null });
        } else {
          this.emit({ phase: 'suspect', reason, error: null });
        }
      } else {
        this.emit({ phase: 'suspect', reason, error: null });
      }
      return this.snapshot();
    }
    this.retry.delete(kind);
    if (release) {
      try {
        const valid = () => this.active && token === this.generation;
        await this.effect(async () => {
          if (!valid()) return;
          await this.unlock(valid);
          if (!valid()) await this.lock();
        });
        if (!this.active || token !== this.generation) return this.snapshot();
        this.releasePending = false;
        this.failures.clear();
        this.retry.clear();
        this.emit({ phase: 'healthy', reason: null, error: null, lockedAt: null });
      } catch (e) { return this.trip(`恢复失败：${e.message}`); }
    } else if (this.state.phase !== 'checking' && !this.failures.size && this.state.items.every(x => x.state === 'ok')) {
      // 完整通过后解除"曾经锁定"的过敏状态，否则一次断流会让系统此后永久一碰就锁
      this.everLocked = false;
      this.emit({ phase: 'healthy', reason: null, error: null });
    }
    else this.emit();
    return this.snapshot();
  }
  trip(reason = '检测异常') {
    if (this.tripPromise) return this.tripPromise;
    this.nextResume = this.now() + 10000;
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
