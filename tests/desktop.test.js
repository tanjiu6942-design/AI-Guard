import { describe, it, expect } from "vitest";
import { defaultSettings } from "../core/settings";
import { validateSettings } from "../desktop/settings.mjs";
import { KernelSession } from "../desktop/kernel-session.mjs";
import { DesktopService } from "../desktop/service.mjs";
import { WorkerClient, needsElevation } from "../desktop/worker-client.mjs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  truncateSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const valid = () => ({
  ...defaultSettings(),
  realtimeProtection: false,
  airportUrl: "https://example.com/sub",
  residential: {
    server: "example.net",
    port: 1080,
    username: "u",
    password: "p",
  },
});

describe("desktop settings boundary", () => {
  it("rejects malformed ports, mode and subscription before persisting", () => {
    for (const patch of [
      { mixedPort: 0 },
      { controllerPort: 7890 },
      { mode: "direct" },
      { airportUrl: "file:///secret" },
      { tunEnabled: "true" },
    ]) {
      expect(() => validateSettings({ ...valid(), ...patch })).toThrow();
    }
  });
  it("accepts global mode and preserves passwords exactly", () => {
    const s = valid();
    s.mode = "global";
    s.residential.password = " p:#x ";
    expect(validateSettings(s).residential.password).toBe(" p:#x ");
  });
});

describe("worker transport lifecycle", () => {
  it("launches from a physical working directory when app root is an archive file", async () => {
    const w = new WorkerClient({
      executable: process.execPath,
      args: [join(process.cwd(), "tests", "fixtures", "pipe-worker.mjs")],
      root: join(process.cwd(), "package.json"),
      cwd: process.cwd(),
      dataDir: "unused",
      resources: "unused",
    });
    try {
      await w.start(valid());
      expect(w.running).toBe(true);
    } finally {
      await w.stop();
    }
  });
  it("requires an elevated cleanup for a stale DNS backup even when TUN is off", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiguard-recovery-test-"));
    try {
      expect(needsElevation(valid(), dir)).toBe(false);
      mkdirSync(join(dir, "mihomo"));
      writeFileSync(join(dir, "mihomo", "desktop-dns-backup.json"), "{}");
      expect(needsElevation(valid(), dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const client = () =>
    new WorkerClient({
      executable: process.execPath,
      args: [join(process.cwd(), "tests", "fixtures", "pipe-worker.mjs")],
      root: process.cwd(),
      dataDir: "unused",
      resources: "unused",
    });
  it("cancels stop during pending connection without resurrecting the worker", async () => {
    const w = client();
    const start = w.start(valid()).catch((e) => e);
    await w.stop();
    await start;
    await new Promise((r) => setTimeout(r, 350));
    expect(w.running).toBe(false);
    expect(w.socket).toBeFalsy();
    expect(w.phase).toBe("stopped");
  });
  it("stop is idempotent before pipe close and a fresh start keeps its connection", async () => {
    const w = client();
    await w.start(valid());
    await w.stop();
    await w.stop();
    await w.start(valid());
    expect(w.running).toBe(true);
    await w.stop();
  });
  it("receives background protection events independently of status polling", async () => {
    const w = client();
    await w.start({ ...valid(), fixtureProtection: true });
    expect(w.protection?.phase).toBe('healthy');
    await w.stop();
  });
  it('hydrates persisted filters even when the previous worker is absent', async () => {
    const w = client();
    w.guard = { status: async () => ({ locked: true, complete: true }) };
    await w.refreshProtection();
    expect(w.running).toBe(false);
    expect(w.protection.phase).toBe('locked');
  });
  it('does not claim a complete lock when only a stale record remains', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiguard-protection-state-'));
    try {
      const w = client(); w.dataDir = dir;
      writeFileSync(join(dir, 'protection-state.json'), JSON.stringify({ phase: 'locked', reason: 'DNS changed' }));
      w.guard = { status: async () => ({ locked: false, complete: true }) };
      await w.refreshProtection();
      expect(w.protection.phase).toBe('lock_failed');
      expect(w.protection.reason).toBe('DNS changed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("desktop service", () => {
  async function withService(fn) {
    const dir = mkdtempSync(join(tmpdir(), "aiguard-desktop-test-"));
    const worker = {
      running: false,
      phase: "stopped",
      start: async () => {
        worker.running = true;
      },
      stop: async () => {
        worker.running = false;
      },
      reload: async () => {
        throw Error("reload rejected");
      },
      // service.start / resumeProtection 会先问"本机是否被自己锁住"。
      // 不提供桩就会真的去 execFile guard-filter.exe ——
      // 在 CI 或本机进程繁忙时导致 5s 用例超时（已实测 flaky）。
      guardForRecovery: () => ({ status: async () => ({ locked: false, complete: true, filterCount: 0 }) }),
    };
    const service = new DesktopService({
      dataDir: dir,
      root: process.cwd(),
      worker,
    });
    try {
      await fn(service, worker, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it("persists validated global settings and reads them back", async () =>
    withService(async (s, _w, dir) => {
      await s.call("saveSettings", { ...valid(), mode: "global" });
      expect((await s.call("settings")).mode).toBe("global");
      expect(
        JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).residential
          .username,
      ).toBe("u");
    }));
  it("rejects settings edits while the owned worker is running", async () =>
    withService(async (s, w) => {
      await s.call("saveSettings", valid());
      w.running = true;
      await expect(
        s.call("saveSettings", { ...valid(), mixedPort: 9000 }),
      ).rejects.toThrow();
      expect((await s.call("settings")).mixedPort).toBe(7890);
    }));
  it("keeps saved mode when live reload fails", async () =>
    withService(async (s, w) => {
      await s.call("saveSettings", valid());
      w.running = true;
      await expect(s.call("setMode", "global")).rejects.toThrow(
        "reload rejected",
      );
      expect((await s.call("settings")).mode).toBe("strict");
    }));
  it("rejects arbitrary commands", async () =>
    withService(async (s) => {
      await expect(s.call("exec", "calc.exe")).rejects.toThrow("未知");
    }));
  it('gates selector and exit timezone lookup behind a healthy running worker', async () =>
    withService(async (s, w) => {
      await expect(s.call('selectNode', 'node')).rejects.toThrow('运行');
      await expect(s.call('detectTimezone')).rejects.toThrow('运行');
      w.running = true;
      w.protection = { phase: 'locked' };
      await expect(s.call('selectNode', 'node')).rejects.toThrow('保护');
      w.protection.phase = 'healthy';
      w.selectNode = async name => ({ selected: name });
      w.detectTimezone = async () => ({ windowsId: 'UTC' });
      expect(await s.call('selectNode', 'node')).toEqual({ selected: 'node' });
      expect(await s.call('detectTimezone')).toEqual({ windowsId: 'UTC' });
    }));
  it('uses the worker for timezone writes while running and local restore while stopped', async () =>
    withService(async (s, w) => {
      w.running = true;
      w.setTimezone = async id => ({ current: id });
      expect(await s.call('setTimezone', 'UTC')).toEqual({ current: 'UTC' });
      w.running = false;
      s.timezones = { restore: async () => ({ current: 'China Standard Time' }) };
      expect(await s.call('restoreTimezone')).toEqual({ current: 'China Standard Time' });
    }));
  it("refuses ordinary stop and mode changes while protection is locked", async () =>
    withService(async (s, w) => {
      await s.call('saveSettings', valid());
      w.running = true;
      w.protection = { phase: 'locked' };
      await expect(s.call('stop')).rejects.toThrow(/保护|断流/);
      await expect(s.call('setMode', 'global')).rejects.toThrow(/保护|断流/);
    }));
  it('routes emergency release through elevated recovery when no worker is running', async () =>
    withService(async (s, w) => {
      await s.call('saveSettings', valid());
      w.protection = { phase: 'locked' };
      w.recover = async settings => { expect(settings.mixedPort).toBe(7890); return 'released'; };
      expect(await s.call('releaseProtection')).toBe('released');
      await expect(s.call('saveSettings', valid())).rejects.toThrow(/停止/);
    }));
  it('restarts the protected worker before manually rechecking a persisted lock', async () =>
    withService(async (s, w) => {
      await s.call('saveSettings', { ...valid(), tunEnabled: true, realtimeProtection: true });
      w.protection = { phase: 'locked' };
      const calls = [];
      w.start = async () => { calls.push('start quarantined'); w.running = true; };
      w.resumeProtection = async () => { calls.push('full manual recheck'); };
      await s.call('resumeProtection');
      expect(calls).toEqual(['start quarantined', 'full manual recheck']);
    }));
});

function fixture({ failReady = false, failRestore = false } = {}) {
  const events = [];
  let exits;
  const child = {
    pid: 321,
    stop: async () => {
      events.push("stop-owned");
      exits?.();
    },
    onExit: (fn) => {
      exits = fn;
    },
  };
  const session = new KernelSession({
    launch: async () => {
      events.push("launch");
      return child;
    },
    ready: async () => {
      events.push("ready");
      if (failReady) throw Error("bind failed");
    },
    applyDns: async () => {
      events.push("apply");
    },
    restoreDns: async () => {
      events.push("restore");
      if (failRestore) throw Error("DNS restore failed");
    },
  });
  return { session, events, child };
}

describe("owned kernel lifecycle", () => {
  it("starts once, waits for readiness, restores DNS after child exit", async () => {
    const { session, events } = fixture();
    await Promise.all([session.start(true), session.start(true)]);
    await Promise.all([session.stop(), session.stop()]);
    expect(events).toEqual([
      "launch",
      "ready",
      "apply",
      "stop-owned",
      "restore",
    ]);
    expect(session.running).toBe(false);
  });
  it("startup failure kills its child without applying DNS", async () => {
    const { session, events } = fixture({ failReady: true });
    await expect(session.start(true)).rejects.toThrow("bind failed");
    expect(events).toEqual(["launch", "ready", "stop-owned"]);
  });
  it("does not change DNS for proxy-only mode", async () => {
    const { session, events } = fixture();
    await session.start(false);
    await session.stop();
    expect(events).toEqual(["launch", "ready", "stop-owned"]);
  });
  it("surfaces restoration failure instead of claiming successful cleanup", async () => {
    const { session } = fixture({ failRestore: true });
    await session.start(true);
    await expect(session.stop()).rejects.toThrow("DNS restore failed");
  });
});

describe("desktop log tail reading on huge log files", () => {
  it("reads the last N lines from a >600MB desktop.log in milliseconds without ERR_STRING_TOO_LONG or main-thread freeze", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiguard-huge-log-"));
    try {
      const mihomoDir = join(dir, "mihomo");
      mkdirSync(mihomoDir, { recursive: true });
      const logPath = join(mihomoDir, "desktop.log");
      writeFileSync(logPath, "header\n");
      // 模拟实机 600MB+ 的超大 desktop.log（超过 V8 单字符串 512MB 上限 0x1fffffe8）
      truncateSync(logPath, 600 * 1024 * 1024);
      const expected = Array.from({ length: 250 }, (_, i) => `[2026-11-11] line-${i + 1}`);
      appendFileSync(logPath, "\n" + expected.join("\n") + "\n", "utf8");

      const svc = new DesktopService({ dataDir: dir, root: process.cwd(), worker: { running: false } });
      const t0 = Date.now();
      const lines = svc.logs(200).filter(Boolean);
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(200);
      expect(lines.length).toBe(200);
      expect(lines[0]).toBe("[2026-11-11] line-51");
      expect(lines[199]).toBe("[2026-11-11] line-250");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
