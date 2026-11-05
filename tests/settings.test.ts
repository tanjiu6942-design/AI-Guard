import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, loadSettings, saveSettings } from '../core/settings';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aiguard-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('设置', () => {
  it('默认模式为严格', () => {
    expect(defaultSettings().mode).toBe('strict');
  });

  it('默认 TUN 关闭（并行验证期安全）', () => {
    expect(defaultSettings().tunEnabled).toBe(false);
  });

  it('保存后可读回', () => {
    const p = join(dir, 'settings.json');
    const s = defaultSettings();
    s.airportUrl = 'https://x/sub';
    s.residential = { server: '1.2.3.4', port: 1, username: 'u', password: 'p' };
    saveSettings(p, s);
    const back = loadSettings(p);
    expect(back.airportUrl).toBe('https://x/sub');
    expect(back.residential.server).toBe('1.2.3.4');
  });

  it('文件不存在时返回默认值', () => {
    const s = loadSettings(join(dir, 'nope.json'));
    expect(s.mode).toBe('strict');
  });

  it('文件损坏时返回默认值而不抛错', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(() => loadSettings(p)).not.toThrow();
    expect(loadSettings(p).mode).toBe('strict');
  });
});
