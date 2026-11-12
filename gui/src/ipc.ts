export type Mode = "strict" | "precise" | "global";
export interface Settings {
  mode: Mode;
  airportUrl: string;
  residential: {
    server: string;
    port: number;
    username: string;
    password: string;
  };
  mixedPort: number;
  controllerPort: number;
  secret: string;
  homeRegion: string;
  tunEnabled: boolean;
  realtimeProtection?: boolean;
  takeoverDns?: boolean;
  autoReconnect?: boolean;
  mihomoPath: string;
}
export interface ProtectionStatus {
  phase:
    | "off"
    | "checking"
    | "healthy"
    | "suspect"
    | "locking"
    | "locked"
    | "recovering"
    | "lock_failed";
  reason: string | null;
  checkedAt: string | null;
  fullCheckedAt: string | null;
  lockedAt: string | null;
  items: CheckResult[];
  error?: string | null;
  /** 一键修复后：自动断流已暂停，检测照常但不再上锁。 */
  suspended?: boolean;
}
export interface Status {
  running: boolean;
  phase:
    "stopped" | "elevating" | "starting" | "running" | "stopping" | "failed";
  error: string | null;
  mode: Mode;
  tunEnabled: boolean;
  mixedPort: number;
  exitIp: string | null;
  exitCountry: string | null;
  protection?: ProtectionStatus;
}
export interface CheckResult {
  key: string;
  title: string;
  state: "ok" | "fail" | "warn" | "unknown";
  detail: string;
  checkedAt?: string | null;
}
export interface Finding {
  domain: string;
  count: number;
  actualGroup: string;
  suggestedRule: string;
}
export interface NodeStatus {
  group: string;
  selected: string;
  nodes: { name: string; type: string; delay: number | null; alive: boolean | null }[];
}
export interface TimezoneStatus {
  current: string;
  original: string | null;
  zones: { id: string; displayName: string }[];
  automatic: boolean;
}
export interface DetectedTimezone {
  ip: string;
  iana: string;
  windowsId: string;
  source: string;
}
/** 一键修复的结果。界面据此直接给出结论，不需要自己推断。 */
export interface RepairResult {
  /** 整体是否成功（防火墙已确认解除，或本来就没锁）。 */
  ok: boolean;
  /** 本次是否真的解除了锁定。false 表示本来就没锁。 */
  unlocked: boolean;
  /** 失败原因；成功时为 null。 */
  error: string | null;
}
export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  url: string;
  releaseNotes?: string;
}
export interface DesktopAPI {
  nodes(): Promise<NodeStatus>;
  selectNode(name: string): Promise<NodeStatus>;
  timezone(): Promise<TimezoneStatus>;
  detectTimezone(): Promise<DetectedTimezone>;
  setTimezone(id: string): Promise<TimezoneStatus>;
  restoreTimezone(): Promise<TimezoneStatus>;
  status(): Promise<Status>;
  settings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;
  start(): Promise<void>;
  stop(): Promise<void>;
  resumeProtection(): Promise<void>;
  releaseProtection(): Promise<void>;
  /** 一键修复：解除异常退出导致的整机断网。不依赖内核存活。 */
  repairNetwork(): Promise<RepairResult>;
  /** 恢复自动断流（一键修复后暂停了它）。 */
  resumeAutoLock(): Promise<void>;
  setMode(mode: Mode): Promise<Mode>;
  doctor(): Promise<CheckResult[]>;
  logs(n: number): Promise<string[]>;
  scan(): Promise<Finding[]>;
  chooseKernel(): Promise<string | null>;
  openFolder(): Promise<void>;
  /** 检查 GitHub 是否有新版本发布。 */
  checkUpdate(): Promise<UpdateInfo>;
  /** 打开官方外部链接（受信任的 GitHub 地址）。 */
  openUrl(url: string): Promise<void>;
}
declare global {
  interface Window {
    aiGuard: DesktopAPI;
  }
}
export const api = window.aiGuard;
