import { describe, it, expect, vi } from "vitest";
import { isNewerVersion, DesktopService } from "../desktop/service.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("版本对比逻辑 isNewerVersion", () => {
  it("补丁版本更新识别", () => {
    expect(isNewerVersion("0.3.5", "0.3.4")).toBe(true);
    expect(isNewerVersion("v0.3.5", "0.3.4")).toBe(true);
    expect(isNewerVersion("0.3.5", "v0.3.4")).toBe(true);
  });

  it("次版本更新识别", () => {
    expect(isNewerVersion("0.4.0", "0.3.4")).toBe(true);
    expect(isNewerVersion("0.4.1", "0.3.4")).toBe(true);
  });

  it("主版本更新识别", () => {
    expect(isNewerVersion("1.0.0", "0.3.4")).toBe(true);
    expect(isNewerVersion("2.0.0", "0.3.4")).toBe(true);
  });

  it("相同或旧版本判定为不需要更新", () => {
    expect(isNewerVersion("0.3.4", "0.3.4")).toBe(false);
    expect(isNewerVersion("v0.3.4", "0.3.4")).toBe(false);
    expect(isNewerVersion("0.3.3", "0.3.4")).toBe(false);
    expect(isNewerVersion("0.2.9", "0.3.4")).toBe(false);
  });

  it("空值或异常输入安全返回 false", () => {
    expect(isNewerVersion("", "0.3.4")).toBe(false);
    expect(isNewerVersion(null, "0.3.4")).toBe(false);
    expect(isNewerVersion("0.3.5", "")).toBe(false);
    expect(isNewerVersion("0.3.5", null)).toBe(false);
  });
});

describe("DesktopService.checkUpdate 检查更新接口", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "aiguard-update-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.4" }));
    const service = new DesktopService({
      dataDir: dir,
      root: dir,
      worker: { corePid: null },
    });
    return { dir, service };
  }

  it("当 GitHub 返回新版本时返回 hasUpdate=true 及最新版本号", async () => {
    const { dir, service } = fixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.5",
        html_url: "https://github.com/tanjiu6942-design/AI-Guard/releases/tag/v0.3.5",
        name: "AI Guard v0.3.5",
        body: "修复若干问题",
      }),
    });

    try {
      const res = await service.call("checkUpdate");
      expect(res.hasUpdate).toBe(true);
      expect(res.currentVersion).toBe("0.3.4");
      expect(res.latestVersion).toBe("0.3.5");
      expect(res.url).toContain("v0.3.5");
      expect(res.releaseNotes).toContain("AI Guard v0.3.5");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("当远端版本不高于本地版本时返回 hasUpdate=false", async () => {
    const { dir, service } = fixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.4",
        html_url: "https://github.com/tanjiu6942-design/AI-Guard/releases/tag/v0.3.4",
        name: "AI Guard v0.3.4",
      }),
    });

    try {
      const res = await service.checkUpdate();
      expect(res.hasUpdate).toBe(false);
      expect(res.currentVersion).toBe("0.3.4");
      expect(res.latestVersion).toBe("0.3.4");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("当网络异常或超时时静默返回，不抛异常", async () => {
    const { dir, service } = fixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    try {
      const res = await service.checkUpdate();
      expect(res.hasUpdate).toBe(false);
      expect(res.currentVersion).toBe("0.3.4");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openUrl 安全链接白名单校验", () => {
  const allowed = (url) =>
    /^https:\/\/github\.com\/tanjiu6942-design\/AI-Guard(\/.*)?$/i.test(String(url || ""));

  it("仅允许官方 GitHub 仓库链接", () => {
    expect(allowed("https://github.com/tanjiu6942-design/AI-Guard")).toBe(true);
    expect(allowed("https://github.com/tanjiu6942-design/AI-Guard/releases/latest")).toBe(true);
    expect(allowed("https://github.com/tanjiu6942-design/AI-Guard/releases/tag/v0.3.4")).toBe(true);
  });

  it("拦截外部未知链接", () => {
    expect(allowed("https://evil.com/malware.exe")).toBe(false);
    expect(allowed("http://github.com/tanjiu6942-design/AI-Guard")).toBe(false); // 必须 https
    expect(allowed("https://github.com/other-org/other-repo")).toBe(false);
    expect(allowed("file:///C:/Windows/System32/cmd.exe")).toBe(false);
    expect(allowed("")).toBe(false);
  });
});
