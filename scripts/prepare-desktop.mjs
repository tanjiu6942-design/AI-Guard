import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadSettings } from "../dist/core/settings.js";
import { findMihomo, GEODATA_FILES } from "../dist/core/runtime/mihomo.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "vendor", "mihomo");
mkdirSync(dest, { recursive: true });
const s = loadSettings(
  join(process.env.APPDATA || ".", "aiguard", "settings.json"),
);
const source =
  process.env.AIGUARD_MIHOMO_PATH ||
  s.mihomoPath ||
  findMihomo() ||
  join(dest, "mihomo.exe");
if (!existsSync(source))
  throw Error(
    "未找到内核。设置 AIGUARD_MIHOMO_PATH 指向 mihomo.exe 后重新运行 desktop:prepare",
  );
const dirs = [
  dirname(source),
  join(process.env.APPDATA || ".", "aiguard", "mihomo"),
  dest,
];
const files = ["mihomo.exe", ...GEODATA_FILES];
for (const file of files) {
  const src =
    file === "mihomo.exe"
      ? source
      : dirs.map((d) => join(d, file)).find(existsSync);
  if (!src) throw Error(`缺少 ${file}，请放到 mihomo.exe 同目录再构建`);
  if (src.toLowerCase() !== join(dest, file).toLowerCase())
    copyFileSync(src, join(dest, file));
}
const license = join(dest, "LICENSE-mihomo.txt");
if (!existsSync(license)) {
  const response = await fetch(
    "https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/LICENSE",
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw Error("无法获取 mihomo GPL 许可证");
  writeFileSync(license, await response.text());
}
const version = execFileSync(join(dest, "mihomo.exe"), ["-v"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
writeFileSync(
  join(dest, "UPSTREAM.txt"),
  `${version}\n\nUpstream source and release source archives: https://github.com/MetaCubeX/mihomo\nLicense: GNU GPL v3 (see LICENSE-mihomo.txt)\nGeodata: https://github.com/MetaCubeX/meta-rules-dat\nThis package contains no personal subscription or credentials.\n`,
);
const hashes = Object.fromEntries(
  files.map((f) => [
    f,
    createHash("sha256")
      .update(readFileSync(join(dest, f)))
      .digest("hex"),
  ]),
);
writeFileSync(
  join(dest, "manifest.json"),
  JSON.stringify({ version, sha256: hashes }, null, 2),
);
console.log(
  `已暂存 ${files.length} 个内核资源；未复制个人配置、订阅缓存或日志。`,
);
console.log(version);
