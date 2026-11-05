# Windows Desktop Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; the user authorized implementation in this chat.

**Goal:** Deliver an installable Windows desktop app with the current AI Guard features and owned kernel cleanup.

**Architecture:** Electron renderer -> restricted preload IPC -> DesktopService. A separate optionally elevated worker owns mihomo and DNS, connected to the UI through a random named pipe.

**Tech Stack:** Electron, Electron Builder NSIS, existing TypeScript core, React/Vite, Vitest.

**Spec:** ../specs/2026-11-03-windows-desktop-design.md

## Global Constraints

- Windows 10/11 x64; no external browser, 9123 server or installed Node.js.
- Reuse %APPDATA%/aiguard/settings.json; never bundle personal settings or credentials.
- Only stop owned processes. DNS restoration follows kernel termination, failures preserve the backup.
- No automatic kernel startup or real TUN activation during smoke verification.
- Current directory has no Git metadata; work in place, no commits or worktree creation.

## Tasks

### 1. Desktop service contracts and lifecycle
Files: desktop/settings.mjs, desktop/kernel-session.mjs, tests/desktop.test.js; vitest.config.ts.
Interfaces: validateSettings(value) -> Settings; KernelSession({launch,ready,applyDns,restoreDns}) with start/stop.
- [x] Write behavior tests for invalid settings, repeated start, failed launch, stopping only owned child and DNS restore order.
- [x] Run `npx vitest run tests/desktop.test.js`, observe missing implementation failure.
- [x] Implement validation and serialized lifecycle; run the test again.

### 2. Desktop host and worker
Files: desktop/service.mjs, desktop/worker.mjs, desktop/worker-client.mjs, desktop/probes.mjs, desktop/main.cjs, desktop/preload.cjs.
Interfaces: service.call(method, payload) -> result; pipe messages {id,method,payload} and {id,result,error}; methods status/settings/saveSettings/start/stop/setMode/doctor/logs/scan/openFolder/chooseKernel.
- [x] Test service config persistence, active-config lock, failed hot reload rollback, unknown method rejection, pipe loss cleanup.
- [x] Implement named pipe transport, UAC worker launch, owned child management and DNS cleanup.
- [x] Add restricted renderer IPC, local resource protocol, single instance, tray and asynchronous exit.
- [x] Verify service tests and worker integration with a harmless controlled child fixture.

### 3. Desktop UI
Files: gui/src/App.tsx, gui/src/ipc.ts, gui/src/styles.css, gui/vite.config.ts, gui/tsconfig.json, gui/index.html.
- [x] Replace Tauri invoke adapter with typed preload API, retain legacy Rust folder as reference.
- [x] Implement overview, editable configuration, diagnosis, logs/rule scan with loading/error states.
- [x] Run GUI typecheck and build; run actual Electron and inspect screenshots at 100%/200%.

### 4. Installer and final verification
Files: package.json, electron-builder.yml, scripts/prepare-desktop.mjs, scripts/desktop-smoke.cjs, README.md.
- [x] Install pinned Electron and Builder, compile core/GUI, stage required runtime resources and license.
- [x] Build win-unpacked and NSIS; execute packaged smoke in isolated test appdata.
- [x] Run `npm test`, `npm run typecheck`, GUI typecheck and packaged smoke. Review changes and correct important findings.
- [x] Record exact artifact paths and limitations, including unsigned installer and untested physical TUN changes.

## Verification result

See ../../windows-desktop-validation.md for executed commands, packaged smoke evidence, and the physical TUN limitation. No Git repository was present; no commit or worktree was created.
