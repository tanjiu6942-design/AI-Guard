import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const snapshot = (phase) => ({ phase, reason: "fixture reason", error: null, lockedAt: "2026-11-03T08:00:00Z", checkedAt: null, fullCheckedAt: null, items: [] });

async function fixture(phase = "off", {
  running = true, response = 1, rejectMethod,
  notificationSupported = true, refreshPhase,
} = {}) {
  const app = new EventEmitter();
  const prevented = [];
  Object.assign(app, {
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    getPath: () => "D:/fixture-aiguard-main-data",
    setPath: vi.fn(), requestSingleInstanceLock: () => true,
    setAppUserModelId: vi.fn(), exit: vi.fn(),
    quit: vi.fn(() => {
      let blocked = false;
      app.emit("before-quit", { preventDefault: () => { blocked = true; } });
      prevented.push(blocked);
    }),
  });
  const calls = [];
  const windows = [], trays = [], notifications = [];
  let worker;
  class WorkerClient {
    constructor() { this.protection = snapshot(phase); this.running = running; worker = this; }
    async refreshProtection() {
      if (refreshPhase) {
        this.protection = snapshot(refreshPhase);
        this.onProtection?.(this.protection);
      }
      return this.protection;
    }
  }
  class DesktopService {
    async call(method) {
      calls.push(method);
      if (method === rejectMethod) throw Error("fixture service failure");
      return null;
    }
  }
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); windows.push(this);
      this.webContents = { mainFrame: { url: "aiguard://app/index.html" },
        setWindowOpenHandler: vi.fn(), on: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn() } };
      this.show = vi.fn(); this.hide = vi.fn(); this.focus = vi.fn();
    }
    isMinimized() { return false; }
    async loadURL() {}
  }
  class Tray extends EventEmitter {
    constructor() { super(); trays.push(this); this.destroy = vi.fn(); }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
  }
  class Notification extends EventEmitter {
    static isSupported() { return notificationSupported; }
    constructor(options) { super(); this.options = options; this.show = vi.fn(); notifications.push(this); }
  }
  const dialog = { showMessageBox: vi.fn(async () => ({ response })), showErrorBox: vi.fn() };
  const handlers = new Map();
  const powerMonitor = new EventEmitter();
  const electron = { app, BrowserWindow, Tray, Notification, dialog, powerMonitor,
    Menu: { buildFromTemplate: (template) => template },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    net: {}, shell: {} };
  // Replace only module loading at the VM boundary; run the real main entrypoint.
  const source = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8")
    .replace(/import\((["'])\.\/([^"']+)\1\)/g, (_match, _quote, name) => `__load(${JSON.stringify(name)})`);
  vm.runInNewContext(source, {
    require: (name) => name === "electron" ? electron : name === "node:fs" ? { mkdirSync() {}, writeFileSync() {}, appendFileSync() {} } : require(name),
    __dirname: "D:/aiguard/desktop", process: { argv: ["electron", "main.cjs"], env: {}, execPath: "fixture-electron" },
    __load: async (name) => {
      if (name === "worker-client.mjs") return { WorkerClient };
      if (name === "service.mjs") return { DesktopService };
      // 主进程用它在 worker 已退出时经 UAC 解除整机断流(坑 26)。
      if (name === "elevate-guard.mjs") return { elevateGuardCommand: async () => 0 };
      throw Error(`unexpected fixture import: ${name}`);
    },
    console, URL, Response, setTimeout, clearTimeout,
  });
  await flush();
  expect(dialog.showErrorBox).not.toHaveBeenCalled();
  const win = windows[0], tray = trays[0];
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return { app, calls, dialog, win, tray, worker, notifications, powerMonitor, prevented,
    ipc: (method) => handlers.get("aiguard:call")(event, method),
    emitProtection: async (next) => { worker.protection = next; worker.onProtection?.(next); await flush(); },
  };
}

describe("desktop main protection lifecycle", () => {
  it("cancels renderer release without calling the service", async () => {
    const f = await fixture("locked", { response: 1 });
    expect(await f.ipc("releaseProtection")).toEqual({ ok: true, value: null });
    expect(f.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
  });
  it("requires a concrete ordinary-network warning before renderer release", async () => {
    const f = await fixture("locked", { response: 0 });
    await f.ipc("releaseProtection");
    const options = f.dialog.showMessageBox.mock.calls[0]?.at(-1);
    expect(options?.detail).toMatch(/整机断流/);
    expect(options?.detail).toMatch(/普通网络/);
    expect(options?.detail).toMatch(/停止.*保护/);
    expect(f.calls).toEqual(["releaseProtection"]);
  });
  it("updates tray state and deduplicates lock notifications with click-to-open", async () => {
    const f = await fixture("healthy");
    const locked = snapshot("locked");
    await f.emitProtection(locked);
    await f.emitProtection({ ...locked, checkedAt: "later" });
    expect(f.tray.tooltip).toMatch(/已断流/);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0].options.body).toMatch(/fixture reason/);
    expect(f.notifications[0].show).toHaveBeenCalledOnce();
    f.win.show.mockClear(); f.notifications[0].emit("click");
    expect(f.win.show).toHaveBeenCalledOnce();
    await f.emitProtection({ ...locked, phase: "lock_failed", error: "filter denied" });
    expect(f.tray.tooltip).toMatch(/断流失败/);
    expect(f.notifications).toHaveLength(2);
  });
  it("does not spam repeated executor errors within one lock incident", async () => {
    const f = await fixture("healthy");
    await f.emitProtection({ ...snapshot("lock_failed"), error: "attempt one" });
    await f.emitProtection({ ...snapshot("lock_failed"), error: "attempt two" });
    expect(f.notifications).toHaveLength(1);
  });
  it("does not present healthy protection when the kernel is no longer running", async () => {
    const f = await fixture("healthy", { running: false });
    expect(f.tray.tooltip).not.toMatch(/正常保护/);
    expect(f.tray.tooltip).toMatch(/内核未运行/);
  });
  it("hydrates a persisted lock before showing the tray even if notifications are unavailable", async () => {
    const f = await fixture("off", { running: false, refreshPhase: "locked", notificationSupported: false });
    expect(f.tray.tooltip).toMatch(/已断流/);
    expect(f.notifications).toEqual([]);
    expect(f.tray.menu.find((item) => item.label === "复检并恢复")?.enabled).toBe(true);
  });
  it("offers tray recovery and an explicit confirmed emergency exit", async () => {
    const f = await fixture("locked", { response: 1 });
    const recovery = f.tray.menu.find((item) => item.label === "复检并恢复");
    const release = f.tray.menu.find((item) => /退出保护/.test(item.label));
    expect(recovery?.enabled).toBe(true);
    await recovery.click(); await flush();
    expect(f.calls).toEqual(["resumeProtection"]);
    await release.click(); await flush();
    expect(f.calls).toEqual(["resumeProtection"]);
    expect(f.tray.menu.some((item) => item.label === "退出程序")).toBe(true);
  });
  it("preserves an existing lock on quit without invoking release", async () => {
    const f = await fixture("locked"); f.app.quit(); await flush();
    expect(f.calls).toEqual(["shutdown"]);
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(f.tray.destroy).toHaveBeenCalledOnce();
    expect(f.prevented).toEqual([true, false]);
  });
  it("defaults healthy quit to preserving the lock and prevents reentrant shutdown", async () => {
    const f = await fixture("healthy", { response: 0 });
    f.app.quit(); f.app.quit(); await flush();
    const options = f.dialog.showMessageBox.mock.calls[0]?.at(-1);
    expect(options?.buttons).toHaveLength(3);
    expect(options?.defaultId).toBe(0);
    expect(options?.cancelId).toBe(2);
    expect(f.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(f.calls).toEqual(["shutdown"]);
  });
  it("only releases protection on the explicit healthy quit choice", async () => {
    const f = await fixture("healthy", { response: 1 }); f.app.quit(); await flush();
    expect(f.calls).toEqual(["releaseProtection"]);
    expect(f.tray.destroy).toHaveBeenCalledOnce();
  });
  it("keeps the app alive on cancel or shutdown failure", async () => {
    const canceled = await fixture("healthy", { response: 2 }); canceled.app.quit(); await flush();
    expect(canceled.calls).toEqual([]); expect(canceled.tray.destroy).not.toHaveBeenCalled();
    const failed = await fixture("locked", { rejectMethod: "shutdown" }); failed.app.quit(); await flush();
    expect(failed.tray.destroy).not.toHaveBeenCalled();
    expect(failed.dialog.showErrorBox).toHaveBeenCalledWith("无法安全退出", expect.stringContaining("fixture service failure"));
    failed.app.quit(); await flush(); expect(failed.calls).toEqual(["shutdown", "shutdown"]);
  });
  it("does not show a modal for ordinary off-mode automation quits", async () => {
    const f = await fixture("off"); f.app.quit(); await flush();
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["shutdown"]);
  });
  it("rechecks only healthy or suspect protection after wake without unlocking", async () => {
    const f = await fixture("healthy"); f.powerMonitor.emit("resume"); await flush();
    expect(f.calls).toEqual(["doctor"]);
    await f.emitProtection(snapshot("locked")); f.powerMonitor.emit("resume"); await flush();
    expect(f.calls).toEqual(["doctor"]);
    await f.emitProtection(snapshot("suspect")); f.powerMonitor.emit("resume"); await flush();
    expect(f.calls).toEqual(["doctor", "doctor"]);
  });
});
