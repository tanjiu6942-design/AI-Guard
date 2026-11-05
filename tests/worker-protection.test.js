import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerProtection } from '../desktop/worker-protection.mjs';

async function fixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),'aiguard-guard-runtime-'));
  const events=[];
  const guard={status:async()=>({locked:false}),check:async()=>events.push('check'),lock:async()=>events.push('lock'),unlock:async()=>events.push('unlock')};
  const runtime=new WorkerProtection({guard,dataDir:dir,settings:{},configure:async blocked=>events.push(blocked?'deny':'allow'),
    controller:async endpoint=>endpoint === 'proxies' ? { proxies: {} } : events.push('close'),emit:()=>{},check:async()=>[{key:'exit',title:'出口',state:'ok',detail:'valid'}]});
  try { await fn(runtime,guard,events,dir); } finally { await runtime.shutdown(); rmSync(dir,{recursive:true,force:true}); }
}
describe('privileged protection lifecycle',()=>{
  it('quarantines before checking and releases only after preflight',async()=>fixture(async(r,_g,e)=>{
    await r.prepare('C:\\fixture\\mihomo.exe');
    expect(e).toEqual(['check','lock']);
    await r.activate(123);
    // 隔离只靠 WFP 系统规则, 启动配置已是正常态, 因此检测通过后
    // 不再下发一次配置(configure=false) —— 那会热重载并拆建 TUN 网卡,
    // 实测正是"检测约 35 秒后才断流"的根因。
    expect(e).toEqual(['check','lock','unlock']);
    expect(r.snapshot().phase).toBe('healthy');
  }));
  it('blocks system and proxy traffic and persists the actual lock',async()=>fixture(async(r,_g,e,dir)=>{
    await r.prepare('C:\\fixture\\mihomo.exe'); await r.activate(123); e.length=0;
    await r.trip('leak');
    expect(e).toEqual(['lock','deny','close']);
    expect(JSON.parse(readFileSync(join(dir,'protection-diagnostic.json'))).controllerAvailable).toBe(true);
    expect(JSON.parse(readFileSync(join(dir,'protection-state.json'))).phase).toBe('locked');
  }));
  it('retains a system block even if proxy policy updates fail',async()=>fixture(async(r,_g,e)=>{
    await r.prepare('C:\\fixture\\mihomo.exe'); await r.activate(123); e.length=0;
    r.configure=async()=>{throw Error('core missing')};
    await r.trip('core crash');
    expect(e[0]).toBe('lock');
    expect(r.snapshot().phase).toBe('lock_failed');
    expect(e).not.toContain('unlock');
  }));
  it('does not automatically release an existing native lock',async()=>fixture(async(r,g,e)=>{
    g.status=async()=>({locked:true}); await r.prepare('C:\\fixture\\mihomo.exe'); await r.activate(123);
    expect(e).not.toContain('unlock'); expect(r.snapshot().phase).toBe('locked');
    await r.resume(); expect(r.snapshot().phase).toBe('healthy');
  }));
});
