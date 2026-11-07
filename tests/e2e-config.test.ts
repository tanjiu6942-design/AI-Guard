import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildConfig } from '../core/config/builder';
import { configToYaml, findMihomo, ensureGeodata, GEODATA_FILES } from '../core/runtime/mihomo';

// mihomo 不一定装在 findMihomo() 的候选路径里 (例如装到 D:\ 的自定义目录),
// 所以允许用 AIGUARD_MIHOMO_PATH 显式指定; 两者都拿不到就跳过而不是失败。
const mihomo = findMihomo() ?? (process.env.AIGUARD_MIHOMO_PATH || null);
const hasMihomo = mihomo !== null && existsSync(mihomo);

describe.skipIf(!hasMihomo)('真实 mihomo 配置校验', () => {
  it('生成的配置通过 mihomo -t 语法检查', () => {
    const cfg = buildConfig({
      mode: 'strict',
      sets: {
        'chatgpt-core': ['DOMAIN-SUFFIX,chatgpt.com'],
        'claude-core': ['DOMAIN-SUFFIX,claude.ai'],
      },
      residential: { server: '1.2.3.4', port: 1000, username: 'u', password: 'p' },
      airportUrl: 'https://example.com/sub',
      mixedPort: 17890,
      controllerPort: 19090,
      secret: 'x',
      homeRegion: 'CN',
      tunEnabled: false,
    });

    const dir = mkdtempSync(join(tmpdir(), 'aiguard-e2e-'));
    try {
      const p = join(dir, 'config.yaml');
      writeFileSync(p, configToYaml(cfg), 'utf8');
      expect(existsSync(p)).toBe(true);

      // 规则里有 GEOIP,private 与 GEOSITE,cn, 缺 geodata 时 mihomo 会联网下载,
      // 下载失败就报 "can't download MMDB" 并启动失败, 所以先把三件套备齐。
      const geodataReady = ensureGeodata(dir, mihomo);
      console.log(`[e2e] ensureGeodata -> ${geodataReady}`);
      for (const f of GEODATA_FILES) {
        const present = existsSync(join(dir, f));
        console.log(`[e2e]   ${f}: ${present ? 'ok' : 'missing'}`);
        // 找不到 geodata 时交给 mihomo 自己下载, 不在这里判失败
        if (geodataReady) expect(present).toBe(true);
      }

      const out = execFileSync(mihomo!, ['-t', '-d', dir, '-f', p], {
        encoding: 'utf8',
        timeout: 30000,
      });
      console.log(out);
      expect(out).toMatch(/configuration file.*test.*successful/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
