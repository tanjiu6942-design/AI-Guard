import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 解析极简 YAML 的 payload 数组。
 * 只支持本项目用到的格式:
 *   payload:
 *     - DOMAIN-SUFFIX,xxx
 *     - DOMAIN,xxx
 * 不引入 YAML 库, 避免额外依赖。
 */
export function parsePayloadYaml(content: string): string[] {
  const out: string[] = [];
  let inPayload = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('payload:')) {
      inPayload = true;
      continue;
    }
    if (!inPayload) continue;
    if (line.startsWith('- ')) {
      const v = line.slice(2).trim();
      if (v) out.push(v);
    } else {
      inPayload = false;
    }
  }
  return out;
}

export function loadRuleSets(dir: string = 'rules/domains'): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  const fallbackPath = join(dir, '..', 'fallback.json');

  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.yaml')) continue;
      const name = f.replace(/\.yaml$/, '');
      try {
        const rules = parsePayloadYaml(readFileSync(join(dir, f), 'utf8'));
        if (rules.length) sets[name] = rules;
      } catch {
        // 单个文件读取失败不阻断整体
      }
    }
  }

  // 用 fallback.json 补全缺失的规则集
  if (existsSync(fallbackPath)) {
    const fb = JSON.parse(readFileSync(fallbackPath, 'utf8')) as Record<string, string[]>;
    for (const [k, v] of Object.entries(fb)) {
      if (!sets[k]) sets[k] = v;
    }
  }

  return sets;
}
