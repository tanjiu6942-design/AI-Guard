const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, basename } = require("node:path");
const root = resolve(__dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "aiguard-desktop-smoke-"));
const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const executable = positional ? resolve(positional) : require("electron");
const flags = [
  "--aiguard-smoke",
  ...process.argv.slice(2).filter((arg) => arg.startsWith("--")),
];
const args =
  basename(executable).toLowerCase() === "electron.exe"
    ? [root, ...flags]
    : flags;
const env = { ...process.env, AIGUARD_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, {
  cwd: root,
  windowsHide: true,
  stdio: "pipe",
  env,
});
const crash = flags.includes("--aiguard-smoke-crash");
let crashPid = null;
const monitor = crash
  ? setInterval(() => {
      const path = join(dataDir, "crash-ready.json");
      if (!existsSync(path)) return;
      clearInterval(monitor);
      crashPid = JSON.parse(readFileSync(path, "utf8")).corePid;
      child.kill("SIGKILL");
    }, 100)
  : null;
let output = "";
child.stdout.on("data", (d) => {
  output += d;
});
child.stderr.on("data", (d) => {
  output += d;
});
const timer = setTimeout(() => {
  child.kill();
  console.error("Desktop smoke timeout", output);
  process.exitCode = 1;
}, 60000);
child.on("error", (e) => {
  clearTimeout(timer);
  console.error(e);
  process.exitCode = 1;
});
child.on("close", async (code) => {
  clearInterval(monitor);
  clearTimeout(timer);
  const reportPath = join(dataDir, "smoke-result.json");
  if (crashPid) {
    const until = Date.now() + 12000;
    let alive = true;
    while (Date.now() < until) {
      try {
        process.kill(crashPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(
      JSON.stringify({
        ok: !alive,
        check:
          "UI force-kill causes independent worker to terminate its owned mihomo",
        dataDir,
      }),
    );
    process.exitCode = alive ? 1 : 0;
    return;
  }
  if (existsSync(reportPath)) {
    console.log(readFileSync(reportPath, "utf8"));
    if (code) console.error(output);
  } else console.error("No smoke report", output);
  console.log(`Evidence: ${dataDir}`);
  process.exitCode = code || (!existsSync(reportPath) ? 1 : 0);
});
