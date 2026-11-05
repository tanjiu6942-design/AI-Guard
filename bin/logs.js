#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const n = Number(process.argv[2] ?? 100);
const p = join(process.env.APPDATA ?? '.', 'aiguard', 'mihomo', 'mihomo.log');
if (!existsSync(p)) process.exit(0);

const lines = readFileSync(p, 'utf8').split(/\r?\n/);
console.log(lines.slice(-n).join('\n'));
