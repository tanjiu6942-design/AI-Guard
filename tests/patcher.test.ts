import { describe, it, expect } from 'vitest';
import { analyzeLog } from '../core/domain/patcher';

const SAMPLE = `
time="2026-11-01T20:40:51Z" level=info msg="[TCP] 127.0.0.1:1(curl.exe) --> a.nel.cloudflare.com:443 match Match using 普通代理[🇺🇲 美国S02]"
time="2026-11-01T20:40:52Z" level=info msg="[TCP] 127.0.0.1:2(ChatGPT.exe) --> chatgpt.com:443 match RuleSet(chatgpt-core) using AI Guard 专用[AI Guard · 独享 IP]"
time="2026-11-01T20:40:53Z" level=info msg="[TCP] 127.0.0.1:3(curl.exe) --> a.nel.cloudflare.com:443 match Match using 普通代理[🇺🇲 美国S02]"
`;

describe('动态补丁', () => {
  it('识别出走了普通代理的 Cloudflare 域名', () => {
    const findings = analyzeLog(SAMPLE, ['chatgpt.com', 'cloudflare.com']);
    const cf = findings.find((f) => f.domain === 'a.nel.cloudflare.com');
    expect(cf).toBeDefined();
    expect(cf?.count).toBe(2);
    expect(cf?.actualGroup).toBe('普通代理');
  });

  it('已正确走专用组的域名不算问题', () => {
    const findings = analyzeLog(SAMPLE, ['chatgpt.com', 'cloudflare.com']);
    expect(findings.find((f) => f.domain === 'chatgpt.com')).toBeUndefined();
  });

  it.each(['REJECT', 'REJECT-DROP'])('主动阻断的 %s 记录不算出口泄漏', (policy) => {
    const log = `time="2026-11-03T15:22:05Z" level=info msg="[UDP] 198.18.0.1:55093 --> cdn.platform.openai.com:443 match AND(((Network,udp) && (DstPort,443))) using ${policy}"`;
    expect(analyzeLog(log, ['openai.com'])).toEqual([]);
  });

  it('同一域名被阻断后仍能识别真正走错出口的 TCP 请求', () => {
    const log = `
time="2026-11-03T15:22:05Z" level=info msg="[UDP] 198.18.0.1:55093 --> cdn.platform.openai.com:443 match AND(((Network,udp) && (DstPort,443))) using REJECT"
time="2026-11-03T15:22:06Z" level=info msg="[TCP] 198.18.0.1:55094 --> cdn.platform.openai.com:443 match Match using DIRECT"
time="2026-11-03T15:22:07Z" level=info msg="[TCP] 198.18.0.1:55095 --> cdn.platform.openai.com:443 match Match using 普通代理[测试节点]"
`;
    expect(analyzeLog(log, ['openai.com'])).toEqual([{
      domain: 'cdn.platform.openai.com',
      count: 2,
      actualGroup: 'DIRECT',
      suggestedRule: 'DOMAIN-SUFFIX,openai.com',
    }]);
  });

  it('无关域名不被报告', () => {
    const findings = analyzeLog(SAMPLE, ['chatgpt.com', 'cloudflare.com']);
    expect(findings.find((f) => f.domain === 'example.com')).toBeUndefined();
  });

  it('生成补丁规则建议', () => {
    const findings = analyzeLog(SAMPLE, ['chatgpt.com', 'cloudflare.com']);
    expect(findings[0].suggestedRule).toBe('DOMAIN-SUFFIX,cloudflare.com');
  });

  it('空日志返回空结果', () => {
    expect(analyzeLog('', ['chatgpt.com'])).toEqual([]);
  });
});
