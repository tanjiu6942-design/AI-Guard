#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rule = process.argv[2];
if (!rule) {
  console.error('用法: patch.js "DOMAIN-SUFFIX,example.com"');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'rules', 'domains', 'chatgpt-core.yaml');
appendFileSync(target, `  - ${rule}\n`, 'utf8');
console.log(`已追加规则: ${rule}`);
