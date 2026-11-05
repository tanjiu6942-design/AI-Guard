const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [resolve(__dirname, ".."), ...process.argv.slice(2)],
  { env, stdio: "inherit", windowsHide: true },
);
child.on("error", (e) => {
  console.error(e);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
