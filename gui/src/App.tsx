import { useEffect, useState, useCallback, useRef } from "react";
import {
  api,
  type Status,
  type Settings,
  type Mode,
  type CheckResult,
  type Finding,
  type NodeStatus,
  type TimezoneStatus,
  type DetectedTimezone,
} from "./ipc";

const MODES: { value: Mode; title: string; detail: string }[] = [
  {
    value: "strict",
    title: "严格",
    detail: "AI 与 Cloudflare 相关流量走住宅出口，其余按规则分流。",
  },
  {
    value: "precise",
    title: "精确",
    detail: "仅规则覆盖的 AI 流量走住宅出口，更省流量，依赖域名规则完整度。",
  },
  {
    value: "global",
    title: "全局",
    detail: "内网和国内站点直连，其余流量走住宅出口，住宅流量消耗较大。",
  },
];
const pages = [
  { key: "overview", label: "连接概览", mark: "01" },
  { key: "settings", label: "连接配置", mark: "02" },
  { key: "doctor", label: "网络体检", mark: "03" },
  { key: "logs", label: "日志与规则", mark: "04" },
];
const LABEL = { ok: "通过", fail: "失败", warn: "注意", unknown: "未知" };
const PROTECTION_LABEL = {
  off: "实时保护未启动",
  checking: "正在检查",
  healthy: "正常保护",
  suspect: "异常复核",
  locking: "正在断流",
  locked: "已断流",
  recovering: "恢复复检",
  lock_failed: "断流失败",
};
const PROTECTION_DETAIL = {
  off: "",
  checking: "正在完成首次体检，普通应用外网连接暂未开放。",
  healthy: "最近检查通过，后台持续按周期监测；异常时锁定整机外网。",
  suspect: "发现异常，正在复核；复核仍未通过时将锁定整机外网。",
  locking: "正在锁定整机外网，请等待执行结果。",
  locked: "整机外网已锁定。完整复检通过后才恢复联网，不会自动解除。",
  recovering: "正在锁定状态下完整复检，全部通过后才恢复普通应用联网。",
  lock_failed: "系统断流执行失败，不能确认整机外网已被阻断。请查看错误并处理。",
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const timeText = (value?: string | null) => {
  if (!value) return "尚无记录";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleString("zh-CN", { hour12: false });
};

export default function App() {
  const [page, setPage] = useState("overview");
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(
    null,
  );
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [nodes, setNodes] = useState<NodeStatus | null>(null);
  const [nodeChoice, setNodeChoice] = useState("");
  const [nodeError, setNodeError] = useState("");
  const [timezone, setTimezone] = useState<TimezoneStatus | null>(null);
  const [zoneChoice, setZoneChoice] = useState("");
  const [zoneError, setZoneError] = useState("");
  const [detectedZone, setDetectedZone] = useState<DetectedTimezone | null>(null);
  const [detectingZone, setDetectingZone] = useState(false);
  const autoDetected = useRef(false);
  const zoneRequestGeneration = useRef(0);
  const zoneSelectionRevision = useRef(0);
  const manualZoneChoice = useRef(false);
  const checkGeneration = useRef(0);
  const refresh = useCallback(async () => {
    setStatus(await api.status());
  }, []);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.status();
        if (alive) setStatus(s);
      } catch (e) {
        if (alive) setNotice({ text: message(e), bad: true });
      }
    };
    void tick();
    void api.timezone().then((s) => {
      if (alive) {
        setTimezone(s);
        if (zoneSelectionRevision.current === 0) setZoneChoice(s.current);
      }
    }).catch((e) => { if (alive) setZoneError(message(e)); });
    void api
      .settings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch((e) => {
        if (alive) setNotice({ text: message(e), bad: true });
      });
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      zoneRequestGeneration.current++;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (page !== "logs") return;
    let alive = true;
    const tick = async () => {
      try {
        const l = await api.logs(200);
        if (alive) setLogs(l);
      } catch (e) {
        if (alive) setNotice({ text: message(e), bad: true });
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [page]);
  async function act(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice({ text: success });
      await refresh();
    } catch (e) {
      setNotice({ text: message(e), bad: true });
    } finally {
      setBusy(false);
    }
  }
  const transitioning =
    !!status && ["starting", "elevating", "stopping"].includes(status.phase);
  const protection = status?.protection;
  const protectionPhase = protection?.phase ?? "off";
  const protectedActive = protectionPhase !== "off";
  const protectionHealthy = protectionPhase === "healthy" && !!status?.running;
  const routeAvailable = !!status?.running &&
    (protectionPhase === "off" || protectionPhase === "healthy") && !transitioning;
  const previousConnection = useRef<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const connection = `${status.running}:${status.mode}`;
    if (previousConnection.current !== null && previousConnection.current !== connection)
      invalidateChecks();
    previousConnection.current = connection;
  }, [status?.running, status?.mode]);
  useEffect(() => {
    if (status?.running === undefined) return;
    // 新内核会话可能使用新的住宅出口；模式切换不重复查询定位服务。
    zoneRequestGeneration.current++;
    autoDetected.current = false;
    setDetectedZone(null);
    setDetectingZone(false);
    setZoneError("");
  }, [status?.running]);
  useEffect(() => {
    if (!routeAvailable) {
      setNodes(null);
      zoneRequestGeneration.current++;
      setDetectingZone(false);
      return;
    }
    let alive = true;
    void api.nodes().then((s) => {
      if (alive) {
        setNodes(s);
        setNodeChoice(s.selected);
        setNodeError("");
      }
    }).catch((e) => { if (alive) setNodeError(message(e)); });
    return () => { alive = false; };
  }, [routeAvailable]);
  useEffect(() => {
    if (!routeAvailable || autoDetected.current) return;
    autoDetected.current = true;
    void detectZone(true);
  }, [routeAvailable]);
  const protectionLocked = ["locked", "lock_failed"].includes(protectionPhase);
  const protectionPending = ["checking", "locking", "recovering"].includes(
    protectionPhase,
  );
  const protectionTone = protectionHealthy
    ? "ok"
    : protectionLocked || protectionPhase === "locking"
      ? "fail"
      : protectedActive
        ? "warn"
        : "";
  const locked = !!status?.running || protectedActive || transitioning || busy;
  const modeLocked =
    busy || transitioning || checking || !status ||
    (protectedActive && !protectionHealthy);
  const protectionText =
    protectionPhase === "healthy" && !status?.running
      ? "等待内核状态复核"
      : PROTECTION_LABEL[protectionPhase];
  // Claude 专项只来自手动体检，周期检查不得覆盖其状态和时间。
  const claudeKeys = ["claude-code", "claude-ip"];
  const periodic = protectedActive ? (protection?.items ?? []) : [];
  const displayedChecks: CheckResult[] = [
    ...periodic.filter((c) => !claudeKeys.includes(c.key)),
    ...(checks ?? []).filter((c) => !claudeKeys.includes(c.key) &&
      !periodic.some((p) => p.key === c.key)),
    ...claudeKeys.map((key) => (checks ?? []).find((c) => c.key === key) ?? {
      key, title: key === "claude-code" ? "Claude Code 线路" : "Claude 看到的 IP",
      state: "unknown" as const,
      detail: "尚未运行手动体检；结果仅代表对应检查时间。",
    }),
  ];
  const stateText =
    protectedActive
      ? protectionText
      : status?.phase === "elevating"
        ? "等待管理员授权"
        : status?.phase === "starting"
          ? "正在启动内核"
          : status?.phase === "stopping"
            ? "正在停止并恢复 DNS"
            : status?.running
              ? "内核运行中 · 实时保护未启动"
              : status?.phase === "failed"
                ? "启动或连接异常"
                : "尚未启动";
  const currentMode = MODES.find((m) => m.value === status?.mode) ?? MODES[0];
  async function runDoctor() {
    const generation = ++checkGeneration.current;
    invalidateChecks(false);
    setChecking(true);
    setNotice(null);
    try {
      const results = await api.doctor();
      if (generation === checkGeneration.current) setChecks(results);
      await refresh();
    } catch (e) {
      setNotice({ text: message(e), bad: true });
    } finally {
      setChecking(false);
    }
  }
  function invalidateChecks(increment = true) {
    if (increment) checkGeneration.current++;
    setChecks((old) => old?.map((c) => ({ ...c, state: "unknown",
      detail: "连接或检查状态已变化，请重新运行完整体检。上次结果已失效。" })) ?? null);
  }
  async function detectZone(automatic = false) {
    const generation = ++zoneRequestGeneration.current;
    const selectionRevision = zoneSelectionRevision.current;
    setDetectingZone(true);
    setZoneError("");
    try {
      const result = await api.detectTimezone();
      if (generation !== zoneRequestGeneration.current) return;
      setDetectedZone(result);
      if (selectionRevision === zoneSelectionRevision.current &&
        (!automatic || !manualZoneChoice.current)) {
        zoneSelectionRevision.current++;
        setZoneChoice(result.windowsId);
      }
    } catch (e) {
      if (generation === zoneRequestGeneration.current) setZoneError(message(e));
    } finally {
      if (generation === zoneRequestGeneration.current) setDetectingZone(false);
    }
  }
  async function changeNode() {
    if (!routeAvailable || !nodeChoice) return;
    await act(async () => {
      try {
        await api.selectNode(nodeChoice);
      } finally {
        invalidateChecks();
        // PUT 可能已生效后才报错；始终读回，不能沿用旧节点结论。
        try {
          const current = await api.nodes();
          setNodes(current);
          setNodeChoice(current.selected);
          setNodeError("");
        } catch (e) {
          setNodes(null);
          setNodeChoice("");
          setNodeError(`无法确认当前节点，请重新读取节点状态：${message(e)}`);
        }
      }
    }, "普通代理节点已切换；现存连接可能继续使用原节点，请重新体检。");
  }
  async function scan() {
    setScanning(true);
    try {
      setFindings(await api.scan());
    } catch (e) {
      setNotice({ text: message(e), bad: true });
    } finally {
      setScanning(false);
    }
  }
  function patch<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (settings) setSettings({ ...settings, [key]: value });
  }
  const changeResidential = (
    key: keyof Settings["residential"],
    value: string | number,
  ) => {
    if (settings)
      patch("residential", { ...settings.residential, [key]: value });
  };
  const monitoringSummary = protectedActive && (
    <section className="card protection-summary">
      <div className="section-heading">
        <h2>实时保护</h2>
        <span className={`badge ${protectionTone}`}>
          {protectionText}
        </span>
      </div>
      <p className="hint monitor-description">
        {PROTECTION_DETAIL[protectionPhase]}
      </p>
      {protection?.reason && (
        <p className="hint monitor-reason">原因：{protection.reason}</p>
      )}
      <dl className="monitor-times">
        <div>
          <dt>最近检查</dt>
          <dd>{timeText(protection?.checkedAt)}</dd>
        </div>
        <div>
          <dt>最近完整体检</dt>
          <dd>{timeText(protection?.fullCheckedAt)}</dd>
        </div>
      </dl>
      <p className="hint">
        本机状态每 5 秒、出口每 15 秒、完整体检每 60 秒检查一次；这是周期监测，无法保证无间隙防护。窗口隐藏后仍继续运行。
      </p>
    </section>
  );
  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AG</span>
          <div>
            <strong>AI Guard</strong>
            <span>网络连接守护</span>
          </div>
        </div>
        <nav aria-label="主导航">
          <div
            className="nav-track"
            style={{
              transform: `translateY(${pages.findIndex((p) => p.key === page) * 50}px)`,
            }}
          />
          {pages.map((p) => (
            <button
              key={p.key}
              className={`nav-item ${page === p.key ? "selected" : ""}`}
              aria-current={page === p.key ? "page" : undefined}
              onClick={() => {
                setPage(p.key);
                setNotice(null);
              }}
            >
              <span>{p.mark}</span>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`dot ${protectionTone}`} />
          {protectionText}
          <small>{status?.running ? "内核运行中" : "内核未运行"}</small>
          <small>关闭窗口后保留在系统托盘</small>
          <button
            className="text-button"
            onClick={() => void act(() => api.openFolder(), "已打开配置目录")}
          >
            打开配置目录 ↗
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="page-header">
          <div>
            <p className="eyebrow">AI GUARD / WINDOWS</p>
            <h1>{pages.find((p) => p.key === page)?.label}</h1>
          </div>
          <span className="desktop-badge">桌面版 · 0.3.1</span>
        </header>
        {notice && (
          <div
            className={`notice ${notice.bad ? "error" : ""}`}
            role={notice.bad ? "alert" : "status"}
          >
            {notice.text}
          </div>
        )}
        {status?.error && !notice && (
          <div className="notice error" role="alert">
            {status.error}
          </div>
        )}
        {(protectionLocked ||
          protectionPhase === "locking" ||
          protectionPhase === "recovering") && (
          <section className="notice error protection-alert" role="alert">
            <strong>{protectionText}</strong>
            <p>{PROTECTION_DETAIL[protectionPhase]}</p>
            {protection?.reason && <p>原因：{protection.reason}</p>}
            {protection?.error && <p>错误：{protection.error}</p>}
            {protection?.lockedAt && (
              <p>触发时间：{timeText(protection.lockedAt)}</p>
            )}
            <div className="protection-actions">
              <button
                className="primary"
                disabled={busy || checking || transitioning || !protectionLocked}
                onClick={() => void act(() => api.resumeProtection())}
              >
                {protectionPhase === "recovering" ? "复检中…" : "复检并恢复"}
              </button>
              <button
                disabled={busy || checking || transitioning || protectionPending}
                onClick={() => void act(() => api.releaseProtection())}
              >
                退出保护并恢复普通网络
              </button>
            </div>
            <p className="hint">
              退出保护会停止安全保护并恢复普通网络，操作前将再次确认；这不代表体检通过。
            </p>
          </section>
        )}
        <div key={page} className="page-body">
          {page === "overview" && (
            <>
              <section
                className={`connection-hero ${protectionHealthy ? "connected" : protectionLocked || protectionPhase === "locking" ? "interrupted" : ""}`}
              >
                <div className="hero-top">
                  <span
                    className={`connection-symbol ${transitioning || protectionPending ? "pending" : ""}`}
                  >
                    ⏻
                  </span>
                  <span className="subtle">
                    {status?.running ? "内核运行中 · " : "内核未运行 · "}
                    {status?.tunEnabled ? "TUN 接管模式" : "本地代理模式"}
                  </span>
                </div>
                <h2 className="hero-title">{stateText}</h2>
                <p className="hero-description">
                  {protectedActive
                    ? PROTECTION_DETAIL[protectionPhase]
                    : status?.running
                      ? "AI 流量按当前规则经前置节点转发至住宅出口。"
                      : "配置好订阅与住宅代理后，启动你的连接链路。"}
                </p>
                <button
                  className={`primary ${status?.running || protectedActive ? "stop" : ""}`}
                  disabled={
                    busy || transitioning || !status || checking || protectionPending
                  }
                  title={protectedActive ? "退出保护并恢复普通网络" : undefined}
                  onClick={() =>
                    void act(
                      () =>
                        protectedActive
                          ? api.releaseProtection()
                          : status?.running
                            ? api.stop()
                            : api.start(),
                      protectedActive
                        ? undefined
                        : status?.running
                          ? "内核已停止，DNS 清理已完成"
                          : "启动请求已完成，请查看当前检查与连接状态",
                    )
                  }
                >
                  {transitioning
                    ? "处理中…"
                    : protectedActive
                      ? "退出保护"
                      : status?.running
                        ? "停止内核"
                        : "启动内核"}
                </button>
                {protectedActive && (
                  <p className="hint">
                    退出保护将停止安全保护并恢复普通网络，操作前将再次确认。
                  </p>
                )}
                <div className="connection-path">
                  <span>本机</span>
                  <i>→</i>
                  <span>机场前置</span>
                  <i>→</i>
                  <span>住宅 SOCKS5</span>
                  <i>→</i>
                  <span>AI 服务</span>
                </div>
              </section>
              <section className="facts">
                <div>
                  <span>{protectedActive ? "最近探测出口 IP" : "当前出口 IP"}</span>
                  <strong>
                    {status?.exitIp ?? (status?.running ? "探测中…" : "—")}
                  </strong>
                  <small>{status?.exitCountry ?? "启动后通过代理探测"}</small>
                </div>
                <div>
                  <span>本地代理端口</span>
                  <strong>{status?.mixedPort ?? "—"}</strong>
                  <small>127.0.0.1 · HTTP / SOCKS5</small>
                </div>
                <div>
                  <span>流量接管</span>
                  <strong>{status?.tunEnabled ? "TUN" : "代理端口"}</strong>
                  <small>
                    {status?.tunEnabled
                      ? "启用时需要管理员授权"
                      : "应用需连接本地代理端口"}
                  </small>
                </div>
              </section>
              {monitoringSummary}
              <section className="card" data-testid="ordinary-node-card" aria-label="普通代理节点设置">
                <div className="section-heading">
                  <h2>普通代理节点</h2>
                  <span className="subtle">{nodes?.group ?? "普通代理组"}</span>
                  <button disabled={!routeAvailable || busy || checking}
                    onClick={() => void act(async () => {
                      try {
                        const current = await api.nodes();
                        setNodes(current);
                        setNodeChoice(current.selected);
                        setNodeError("");
                      } catch (e) {
                        setNodes(null);
                        setNodeChoice("");
                        setNodeError(`无法确认当前节点：${message(e)}`);
                        throw e;
                      }
                    })}>重新读取节点</button>
                </div>
                <p className="hint">当前选择：{nodes?.selected ?? (routeAvailable ? "读取中…" : "启动内核后可查看")}</p>
                {nodeError && <p className="hint" role="alert">{nodeError}</p>}
                <label className="field">
                  选择节点（包含自动选择）
                  <div className="input-action">
                    <select aria-label="普通代理节点" value={nodeChoice}
                      disabled={!routeAvailable || busy || checking || !nodes}
                      onChange={(e) => setNodeChoice(e.target.value)}>
                      {!nodes && <option value="">暂无节点</option>}
                      {nodes?.nodes.map((n) => <option key={n.name} value={n.name}>
                        {n.name} · {n.type} · {n.alive === false ? "不可用" :
                          n.delay === null ? "延迟未知（未测量）" : `${n.delay} ms`}
                      </option>)}
                    </select>
                    <button disabled={!routeAvailable || busy || checking || !nodes || !nodeChoice || nodeChoice === nodes.selected}
                      onClick={() => void changeNode()}>切换节点</button>
                  </div>
                </label>
                <p className="hint">此处仅切换普通代理组；住宅专用链路独立。现存连接可能继续使用原节点。保护异常或锁定期间不可切换。</p>
              </section>
              <section className="card" data-testid="timezone-card" aria-label="Windows 时区设置">
                <div className="section-heading">
                  <h2>Windows 时区</h2>
                  <span className="subtle">当前：{timezone?.current ?? "尚未读取"}</span>
                </div>
                <p className="hint">应用将关闭 Windows 自动时区并修改全局时区，影响本机所有应用；恢复时会还原原有自动时区设置。默认选择住宅出口 IP 对应时区，也可手动选择。</p>
                <label className="field">
                  系统时区
                  <select aria-label="Windows 时区" value={zoneChoice}
                    disabled={busy || !timezone}
                    onChange={(e) => {
                      manualZoneChoice.current = true;
                      zoneSelectionRevision.current++;
                      setZoneChoice(e.target.value);
                    }}>
                    {!timezone && <option value="">尚未读取系统时区</option>}
                    {timezone?.zones.map((z) => <option key={z.id} value={z.id}>{z.displayName} · {z.id}</option>)}
                  </select>
                </label>
                <div className="protection-actions">
                  <button disabled={!routeAvailable || busy || checking || detectingZone || !timezone}
                    onClick={() => void detectZone()}>{detectingZone ? "识别中…" : "识别住宅出口时区"}</button>
                  <button className="primary" disabled={busy || detectingZone || !timezone || !zoneChoice || zoneChoice === timezone.current}
                    onClick={() => void act(async () => {
                      const result = await api.setTimezone(zoneChoice);
                      zoneSelectionRevision.current++;
                      setTimezone(result);
                      setZoneChoice(result.current);
                      setZoneError("");
                    }, "Windows 全局时区已更新")}>应用到 Windows</button>
                  <button disabled={busy || detectingZone || !timezone?.original}
                    onClick={() => void act(async () => {
                      const result = await api.restoreTimezone();
                      zoneSelectionRevision.current++;
                      setTimezone(result);
                      setZoneChoice(result.current);
                      setZoneError("");
                    }, "原 Windows 时区已恢复")}>恢复原时区</button>
                </div>
                {detectedZone && <p className="hint">住宅出口 {detectedZone.ip} · {detectedZone.iana} → {detectedZone.windowsId}（{detectedZone.source}）。请核对选择框中的时区，点击应用后生效。</p>}
                {timezone?.original && <p className="hint">可恢复的原时区：{timezone.original}；恢复不需要启动内核。</p>}
                {timezone?.automatic && <p className="hint">Windows 自动时区已启用；点击应用时将关闭，避免覆盖手动选择。</p>}
                {zoneError && <p className="hint" role="alert">时区操作失败：{zoneError}</p>}
              </section>
              <section className="card">
                <div className="section-heading">
                  <h2>分流模式</h2>
                  <span className="subtle">{currentMode.title}模式</span>
                </div>
                <div className="mode-selector">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      aria-pressed={status?.mode === m.value}
                      className={status?.mode === m.value ? "active" : ""}
                      disabled={modeLocked}
                      onClick={() =>
                        void act(async () => {
                          await api.setMode(m.value);
                          invalidateChecks();
                          if (settings)
                            setSettings({ ...settings, mode: m.value });
                        }, "分流模式已更新")
                      }
                    >
                      {m.title}
                    </button>
                  ))}
                </div>
                <p className="hint mode-description">{currentMode.detail}</p>
                {protectedActive && !protectionHealthy && (
                  <p className="hint">当前保护阶段不可切换模式；修改模式不会解除锁定。</p>
                )}
                <p className="hint">
                  住宅代理不可用时，专用组阻断连接，不回落直连。规则保护范围可通过网络体检与日志核对。
                </p>
              </section>
            </>
          )}
          {page === "settings" && settings && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (locked) return;
                void act(
                  async () => setSettings(await api.saveSettings(settings)),
                  "配置已保存，下次启动内核生效",
                );
              }}
            >
              {locked && (
                <p className="hint form-lock">
                  {protectedActive
                    ? "明确退出保护并恢复普通网络后，才可修改连接参数。"
                    : "停止内核后可修改连接参数。"}
                </p>
              )}
              <fieldset disabled={locked}>
                <section className="card">
                  <div className="section-heading">
                    <h2>上游连接</h2>
                    <span className="subtle">订阅与独享出口</span>
                  </div>
                  <label className="field">
                    机场订阅 URL
                    <input
                      aria-label="机场订阅 URL"
                      type="url"
                      value={settings.airportUrl}
                      onChange={(e) => patch("airportUrl", e.target.value)}
                      placeholder="https://…"
                      autoComplete="off"
                    />
                  </label>
                  <div className="form-grid">
                    <label className="field">
                      住宅代理主机
                      <input
                        aria-label="住宅代理主机"
                        value={settings.residential.server}
                        onChange={(e) =>
                          changeResidential("server", e.target.value)
                        }
                        placeholder="IP 或主机名"
                        autoComplete="off"
                      />
                    </label>
                    <label className="field">
                      SOCKS5 端口
                      <input
                        aria-label="SOCKS5 端口"
                        type="number"
                        min="0"
                        max="65535"
                        value={settings.residential.port}
                        onChange={(e) =>
                          changeResidential("port", Number(e.target.value))
                        }
                      />
                    </label>
                    <label className="field">
                      用户名
                      <input
                        aria-label="用户名"
                        value={settings.residential.username}
                        onChange={(e) =>
                          changeResidential("username", e.target.value)
                        }
                        autoComplete="off"
                      />
                    </label>
                    <label className="field">
                      密码
                      <input
                        aria-label="密码"
                        type="password"
                        value={settings.residential.password}
                        onChange={(e) =>
                          changeResidential("password", e.target.value)
                        }
                        autoComplete="off"
                      />
                    </label>
                  </div>
                </section>
                <section className="card">
                  <div className="section-heading">
                    <h2>本机网络与内核</h2>
                  </div>
                  <label className="switch-row">
                    <div>
                      <strong>实时保护</strong>
                      <span>
                        需要 TUN 和管理员权限；后台周期检测，异常时锁定整机外网，手动完整复检通过后恢复。
                      </span>
                    </div>
                    <input
                      aria-label="实时保护"
                      type="checkbox"
                      checked={settings.realtimeProtection !== false}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          realtimeProtection: e.target.checked,
                          ...(e.target.checked ? { tunEnabled: true } : {}),
                        })
                      }
                    />
                  </label>
                  <label className="switch-row">
                    <div>
                      <strong>TUN 模式</strong>
                      <span>接管系统流量与 DNS，启动时请求管理员授权。</span>
                    </div>
                    <input
                      aria-label="TUN 模式"
                      type="checkbox"
                      checked={settings.tunEnabled}
                      disabled={
                        settings.realtimeProtection !== false && settings.tunEnabled
                      }
                      onChange={(e) => patch("tunEnabled", e.target.checked)}
                    />
                  </label>
                  {settings.realtimeProtection !== false && !settings.tunEnabled && (
                    <p className="hint form-lock">
                      实时保护需要先启用 TUN 模式，才能保存并启动。
                    </p>
                  )}
                  <div className="form-grid">
                    <label className="field">
                      本地代理端口
                      <input
                        aria-label="本地代理端口"
                        type="number"
                        min="1"
                        max="65535"
                        value={settings.mixedPort}
                        onChange={(e) =>
                          patch("mixedPort", Number(e.target.value))
                        }
                      />
                    </label>
                    <label className="field">
                      内核控制端口
                      <input
                        aria-label="内核控制端口"
                        type="number"
                        min="1"
                        max="65535"
                        value={settings.controllerPort}
                        onChange={(e) =>
                          patch("controllerPort", Number(e.target.value))
                        }
                      />
                    </label>
                  </div>
                  <label className="field">
                    自定义 mihomo 路径
                    <div className="input-action">
                      <input
                        aria-label="自定义 mihomo 路径"
                        value={settings.mihomoPath}
                        onChange={(e) => patch("mihomoPath", e.target.value)}
                        placeholder="留空使用随应用提供的内核"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void api
                            .chooseKernel()
                            .then((p) => {
                              if (p) patch("mihomoPath", p);
                            })
                            .catch((e) =>
                              setNotice({ text: message(e), bad: true }),
                            )
                        }
                      >
                        选择文件
                      </button>
                    </div>
                  </label>
                  <p className="hint">
                    请先退出其他 TUN / VPN 客户端，再启用 TUN。
                  </p>
                </section>
              </fieldset>
              <div className="form-bottom">
                <p className="hint">凭据保存在本机配置目录，请妥善保管。</p>
                <button className="primary" type="submit" disabled={locked}>
                  保存配置
                </button>
              </div>
            </form>
          )}
          {page === "doctor" && (
            <>
              {monitoringSummary}
              <section className="card">
                <div className="section-heading">
                  <div>
                    <h2>检查连接的每一环</h2>
                    <p className="hint">
                      出口、DNS、IPv6、WebRTC、长连接、代理冲突，以及独享 IP、断网保护、Claude Code 线路与 Claude 看到的 IP。
                    </p>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      checking || !status?.running || busy || transitioning ||
                      (protectedActive && !protectionHealthy)
                    }
                    onClick={() => void runDoctor()}
                  >
                    {checking
                      ? "检测中…"
                      : protectedActive
                        ? "运行完整体检"
                        : "运行体检"}
                  </button>
                </div>
                {(checking || protectionPending) && (
                  <div className="progress-line" aria-label="正在检测" />
                )}
                {!displayedChecks?.length ? (
                  <div className="empty-state">
                    <strong>
                      {protectedActive
                        ? protectionLocked
                          ? "请使用“复检并恢复”在锁定状态下完整复检"
                          : "后台检查结果将在这里持续更新"
                        : status?.running
                          ? "准备好后，运行一次完整体检"
                          : "启动内核后可运行体检"}
                    </strong>
                    <p>完整体检约需 30–60 秒；结果只反映对应时间的探测。</p>
                  </div>
                ) : (
                  <ul className="checks">
                    {displayedChecks.map((c) => (
                      <li key={c.key}>
                        <span className={`badge ${c.state}`}>
                          {LABEL[c.state]}
                        </span>
                        <div>
                          <strong>{c.title}</strong>
                          <p>{c.detail}</p>
                          {c.checkedAt && (
                            <small className="check-time">
                              检查时间：{timeText(c.checkedAt)}
                            </small>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
          {page === "logs" && (
            <>
              <section className="card">
                <div className="section-heading">
                  <div>
                    <h2>内核日志</h2>
                    <p className="hint">
                      运行期间每 3 秒刷新，显示最近 200 行。
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      void act(
                        async () => setLogs(await api.logs(200)),
                        "日志已刷新",
                      )
                    }
                  >
                    刷新
                  </button>
                </div>
                <pre className="log" tabIndex={0}>
                  {logs.filter(Boolean).join("\n") ||
                    "暂无内核日志。启动内核后将在这里显示。"}
                </pre>
              </section>
              <section className="card">
                <div className="section-heading">
                  <div>
                    <h2>分流规则扫描</h2>
                    <p className="hint">
                      从日志查找已知 AI 域名走错出口的记录。
                    </p>
                  </div>
                  <button disabled={scanning} onClick={() => void scan()}>
                    {scanning ? "扫描中…" : "扫描日志"}
                  </button>
                </div>
                {findings &&
                  (findings.length ? (
                    <ul className="findings">
                      {findings.map((f) => (
                        <li key={f.domain}>
                          <strong>{f.domain}</strong>
                          <span>
                            {f.count} 次 · {f.actualGroup}
                          </span>
                          <code>{f.suggestedRule}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="hint">
                      最近日志中未发现已知 AI 域名走错出口的记录。
                    </p>
                  ))}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
