import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Mode } from './config/types.js';
import type { ResidentialCred } from './config/groups.js';

export interface Settings {
  mode: Mode;
  airportUrl: string;
  residential: ResidentialCred;
  mixedPort: number;
  controllerPort: number;
  secret: string;
  homeRegion: string;
  tunEnabled: boolean;
  realtimeProtection?: boolean;
  mihomoPath: string;
}

export function defaultSettings(): Settings {
  return {
    mode: 'strict',
    airportUrl: '',
    residential: { server: '', port: 0, username: '', password: '' },
    mixedPort: 7890,
    controllerPort: 9090,
    secret: '',
    homeRegion: 'CN',
    tunEnabled: false,   // 并行验证期默认不开 TUN
    realtimeProtection: true,
    mihomoPath: '',
  };
}

export function loadSettings(path: string): Settings {
  const base = defaultSettings();
  if (!existsSync(path)) return base;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    return {
      ...base,
      ...raw,
      residential: { ...base.residential, ...(raw.residential ?? {}) },
    };
  } catch {
    return base;
  }
}

export function saveSettings(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2), 'utf8');
}
