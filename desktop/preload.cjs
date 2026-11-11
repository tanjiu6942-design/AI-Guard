const { contextBridge, ipcRenderer } = require("electron");
const methods = [
  "status",
  "settings",
  "saveSettings",
  "start",
  "stop",
  "setMode",
  "doctor",
  "logs",
  "scan",
  "openFolder",
  "chooseKernel",
  'resumeProtection',
  'releaseProtection',
  'repairNetwork',
  'resumeAutoLock',
  'nodes',
  'selectNode',
  'timezone',
  'detectTimezone',
  'setTimezone',
  'restoreTimezone',
];
const api = Object.fromEntries(
  methods.map((name) => [
    name,
    async (payload) => {
      const reply = await ipcRenderer.invoke("aiguard:call", name, payload);
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
  ]),
);
contextBridge.exposeInMainWorld("aiGuard", Object.freeze(api));
