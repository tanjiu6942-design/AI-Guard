const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  protocol,
  net,
  dialog,
  shell,
  Notification,
  powerMonitor,
} = require("electron");
const { join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { mkdirSync, writeFileSync, appendFileSync } = require("node:fs");

const root = join(__dirname, "..");
const workerIndex = process.argv.indexOf("--aiguard-worker");
if (workerIndex >= 0) {
  app.whenReady().then(async () => {
    const [pipe, dataDir, resources] = process.argv.slice(workerIndex + 1);
    try {
      await (
        await import("./worker.mjs")
      ).runWorker({
        pipe,
        dataDir,
        resources,
        root,
        exit: (code) => app.exit(code),
      });
    } catch {
      app.exit(1);
    }
  });
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "aiguard",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
  if (process.env.AIGUARD_DATA_DIR)
    app.setPath("userData", resolve(process.env.AIGUARD_DATA_DIR));
  else app.setPath("userData", join(app.getPath("appData"), "aiguard"));
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    let win,
      tray,
      service,
      worker,
      desktopBusy = false,
      quitPending = false,
      traySignature,
      lastNotificationKey,
      quitting = false;
    const notifications = new Set();
    const phaseLabels = {
      off: "实时保护未启动",
      checking: "正在检查",
      healthy: "正常保护",
      suspect: "异常复核",
      locking: "正在断流",
      locked: "已断流",
      recovering: "恢复复检",
      lock_failed: "断流失败",
    };
    const currentProtection = () => worker?.protection ?? { phase: "off" };
    const errorText = (error) => error instanceof Error ? error.message : String(error);
    app.setAppUserModelId("com.aiguard.desktop");
    const show = () => {
      win?.show();
      if (win?.isMinimized()) win.restore();
      win?.focus();
    };
    const showFailure = (title, error) => dialog.showErrorBox(title, errorText(error));
    async function desktopAction(action) {
      if (desktopBusy || quitPending || quitting)
        throw Error("正在处理保护操作，请稍后重试");
      desktopBusy = true;
      updateTray();
      try {
        return await action();
      } finally {
        desktopBusy = false;
        updateTray();
      }
    }
    async function releaseProtection() {
      return desktopAction(async () => {
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          title: "退出保护并恢复普通网络",
          message: "确认退出保护并恢复普通网络？",
          detail: "此操作会停止安全保护，解除本软件的整机断流、停止内核并恢复 DNS。普通网络将恢复，应用不再受 AI Guard 实时保护。这不代表体检通过。",
          buttons: ["退出保护并恢复普通网络", "取消"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return null;
        return service.call("releaseProtection");
      });
    }
    function updateTray() {
      if (!tray || quitting) return;
      const phase = currentProtection().phase;
      const active = phase !== "off";
      const busy = desktopBusy || quitPending;
      const signature = `${phase}:${worker?.running}:${busy}`;
      if (signature === traySignature) return;
      traySignature = signature;
      // "正常保护" is only true while the kernel is actually running.
      const label =
        phase === "healthy" && !worker?.running
          ? "保护未生效"
          : phaseLabels[phase] ?? "保护状态未知";
      tray.setToolTip(`AI Guard · ${label}\n${worker?.running ? "内核运行中" : "内核未运行"}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "打开 AI Guard", click: show },
        { label: label, enabled: false },
        { type: "separator" },
        {
          label: "复检并恢复",
          enabled: !busy && ["locked", "lock_failed"].includes(phase),
          click: () => desktopAction(() => service.call("resumeProtection"))
            .catch((error) => showFailure("复检恢复失败", error)),
        },
        {
          label: active ? "退出保护并恢复普通网络" : "停止内核",
          enabled: !busy && (active || !!worker?.running),
          click: () => (currentProtection().phase !== "off"
            ? releaseProtection()
            : desktopAction(() => service.call("stop")))
            .catch((error) => showFailure("退出保护或停止失败", error)),
        },
        { type: "separator" },
        { label: "退出程序", enabled: !busy, click: () => app.quit() },
      ]));
    }
    function notifyProtection(value) {
      if (!["locked", "lock_failed"].includes(value.phase)) {
        lastNotificationKey = null;
        return;
      }
      // error text churns between retries of one incident; keying on it would spam.
      const key = JSON.stringify([value.phase, value.lockedAt, value.reason]);
      if (key === lastNotificationKey) return;
      lastNotificationKey = key;
      // System notification availability never changes local protection state.
      try {
        if (!Notification.isSupported()) return;
        const notification = new Notification({
          title: `AI Guard · ${phaseLabels[value.phase]}`,
          body: `${value.phase === "lock_failed" ? "系统断流执行失败，不能确认整机外网已阻断。" : "整机外网已锁定，完整复检通过后才恢复。"}\n${value.reason || "请打开 AI Guard 查看检查结果。"}${value.error ? `\n${value.error}` : ""}`,
          urgency: "critical",
        });
        notifications.add(notification);
        notification.on("click", show);
        notification.on("close", () => notifications.delete(notification));
        notification.on("failed", () => notifications.delete(notification));
        notification.show();
      } catch {
        // The renderer alert and tray state remain available without notifications.
      }
    }
    async function quitSafely() {
      if (desktopBusy) throw Error("正在处理保护操作，请完成后再次退出。");
      let method = "shutdown";
      if (["healthy", "suspect"].includes(currentProtection().phase)) {
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          title: "退出 AI Guard",
          message: "退出程序时如何处理联网？",
          detail: "保留断流并退出：先锁定整机外网再退出，普通应用继续断网，下次打开后手动复检恢复。\n退出保护并退出：停止安全保护、解除本软件整机断流、停止内核并恢复 DNS，恢复普通网络。\n关闭窗口可继续在托盘监测。",
          buttons: ["保留断流并退出（推荐）", "退出保护并退出", "取消"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (response !== 0 && response !== 1) return;
        if (response === 1) method = "releaseProtection";
      }
      await service.call(method);
      quitting = true;
      tray?.destroy();
      app.quit();
    }
    app.on("second-instance", show);
    app.on("window-all-closed", () => {});
    app
      .whenReady()
      .then(async () => {
        const dataDir = app.getPath("userData");
        mkdirSync(dataDir, { recursive: true });
        const resources = app.isPackaged
          ? process.resourcesPath
          : join(root, "vendor");
        const { WorkerClient } = await import("./worker-client.mjs");
        const { DesktopService } = await import("./service.mjs");
        const { elevateGuardCommand } = await import("./elevate-guard.mjs");
        worker = new WorkerClient({
          executable: process.execPath,
          args: app.isPackaged ? [] : [root],
          root,
          cwd: app.isPackaged ? process.resourcesPath : root,
          dataDir,
          resources,
          // worker 已退出时, 解除整机断流只能由主进程经 UAC 执行 ——
          // 主进程是 asInvoker, 而 guard-filter 的 unlock 要求管理员权限。
          elevation: elevateGuardCommand,
        });
        service = new DesktopService({ dataDir, root, worker });
        worker.onProtection = (value) => {
          updateTray();
          notifyProtection(value);
        };
        await worker.refreshProtection();
        const frontend = resolve(root, "gui", "dist");
        protocol.handle("aiguard", (req) => {
          const url = new URL(req.url);
          const file = resolve(
            frontend,
            "." + decodeURIComponent(url.pathname),
          );
          if (url.host !== "app" || !file.startsWith(frontend + sep))
            return new Response("Forbidden", { status: 403 });
          return net.fetch(pathToFileURL(file).href);
        });
        win = new BrowserWindow({
          title: "AI Guard",
          width: 1080,
          height: 780,
          minWidth: 820,
          minHeight: 620,
          backgroundColor: "#0f1115",
          show: false,
          autoHideMenuBar: true,
          icon: join(root, "gui", "src-tauri", "icons", "icon.ico"),
          webPreferences: {
            preload: join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
          },
        });
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        win.webContents.session.setPermissionRequestHandler(
          (_webContents, _permission, callback) => callback(false),
        );
        win.on("close", (e) => {
          if (!quitting) {
            e.preventDefault();
            win.hide();
          }
        });
        ipcMain.handle("aiguard:call", async (event, method, payload) => {
          try {
            if (
              event.sender !== win.webContents ||
              event.senderFrame !== win.webContents.mainFrame ||
              event.senderFrame.url !== "aiguard://app/index.html"
            )
              throw Error("不允许的调用来源");
            if (method === "chooseKernel") {
              const result = await dialog.showOpenDialog(win, {
                title: "选择 mihomo 内核",
                filters: [{ name: "mihomo", extensions: ["exe"] }],
                properties: ["openFile"],
              });
              return {
                ok: true,
                value: result.canceled ? null : result.filePaths[0],
              };
            }
            if (method === "openFolder") {
              await shell.openPath(dataDir);
              return { ok: true, value: null };
            }
            if (method === "releaseProtection")
              return { ok: true, value: await releaseProtection() };
            const value = method === "resumeProtection"
              ? await desktopAction(() => service.call(method, payload))
              : await service.call(method, payload);
            updateTray();
            return { ok: true, value };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        });
        tray = new Tray(join(root, "gui", "src-tauri", "icons", "icon.ico"));
        updateTray();
        notifyProtection(currentProtection());
        tray.on("double-click", show);
        powerMonitor.on("resume", () => {
          if (desktopBusy || quitPending || quitting ||
            !["healthy", "suspect"].includes(currentProtection().phase)) return;
          void desktopAction(() => service.call("doctor"))
            .catch((error) => showFailure("唤醒后复检失败", error));
        });
        await win.loadURL("aiguard://app/index.html");
        win.show();
        if (process.argv.includes("--aiguard-smoke")) {
          const { runSmoke } = await import("./smoke.mjs");
          await runSmoke({ app, win, service, dataDir });
        }
      })
      .catch((e) => {
        dialog.showErrorBox("AI Guard 启动失败", e.stack || e.message);
        app.exit(1);
      });
    app.on("before-quit", (event) => {
      if (quitting || !service) return;
      event.preventDefault();
      if (quitPending) return;
      quitPending = true;
      updateTray();
      void quitSafely()
        .catch((error) =>
          dialog.showErrorBox(
            "无法安全退出",
            `退出操作未完成，程序仍保留运行：${errorText(error)}\n请处理后再次退出。`,
          ),
        )
        .finally(() => {
          quitPending = false;
          updateTray();
        });
    });
  }
}
