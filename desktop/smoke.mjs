import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";

export async function runSmoke({ app, win, service, dataDir }) {
  const report = { checks: [], screenshots: [] };
  const check = (name) => report.checks.push(name);
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = async (expression) => {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`UI wait timed out: ${expression}`);
  };
  const shot = async (name) => {
    await js(
      "Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(()=>{})))",
    );
    await js(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    const file = join(dataDir, `${name}.png`);
    try {
      writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      report.screenshots.push(file);
    } catch (e) {
      (report.captureErrors ||= []).push(`${name}: ${e.message}`);
    }
  };
  try {
    await wait(
      "document.querySelector('.hero-title')?.textContent === '尚未启动' && !document.querySelector('.primary').disabled",
    );
    assert.equal(await js("typeof window.require"), "undefined");
    assert.equal(win.webContents.getLastWebPreferences().sandbox, true);
    check("sandboxed local renderer and preload IPC");
    await shot("overview");
    const realTimezones = service.timezones;
    let fixtureTimezone = { current: 'China Standard Time', original: null,
      automatic: false, zones: [{ id: 'China Standard Time', displayName: '中国标准时间' }, { id: 'UTC', displayName: 'UTC' }] };
    service.timezones = {
      status: async () => structuredClone(fixtureTimezone),
      set: async id => {
        assert.equal(id, 'UTC');
        fixtureTimezone = { ...fixtureTimezone, current: id, original: 'China Standard Time' };
        return structuredClone(fixtureTimezone);
      },
      restore: async () => {
        fixtureTimezone = { ...fixtureTimezone, current: 'China Standard Time', original: null };
        return structuredClone(fixtureTimezone);
      },
    };
    try {
      await win.webContents.reload();
      await wait("document.querySelector('[aria-label=\"Windows 时区\"]')?.options.length === 2");
      await js(`(() => { const el=document.querySelector('[aria-label="Windows 时区"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'UTC'); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await js("[...document.querySelectorAll('[data-testid=timezone-card] button')].find(b=>b.textContent==='应用到 Windows').click()");
      await wait("document.querySelector('[data-testid=timezone-card]')?.textContent.includes('当前：UTC')");
      await wait("![...document.querySelectorAll('[data-testid=timezone-card] button')].find(b=>b.textContent==='恢复原时区')?.disabled");
      await js("[...document.querySelectorAll('[data-testid=timezone-card] button')].find(b=>b.textContent==='恢复原时区').click()");
      await wait("document.querySelector('[data-testid=timezone-card]')?.textContent.includes('当前：China Standard Time') && !document.querySelector('[data-testid=timezone-card]')?.textContent.includes('可恢复的原时区：')");
      check('timezone UI apply and restore through IPC using an isolated fake, without changing Windows');
    } finally { service.timezones = realTimezones; }
    await wait("![...document.querySelectorAll('.mode-selector button')].find(b=>b.textContent==='全局')?.disabled");
    await js(
      "[...document.querySelectorAll('.mode-selector button')].find(b=>b.textContent==='全局').click()",
    );
    await wait(
      "document.querySelector('.mode-selector button.active')?.textContent === '全局'",
    );
    assert.equal(service.settings().mode, "global");
    check("global mode saved through UI");
    await js("document.querySelectorAll('.nav-item')[1].click()");
    await wait("!!document.querySelector('[aria-label=\"本地代理端口\"]')");
    await js(
      `(() => { const el=document.querySelector('[aria-label="本地代理端口"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'17892');el.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    );
    await js("document.querySelector('form').requestSubmit()");
    await wait(
      "document.querySelector('[role=status]')?.textContent.includes('配置已保存')",
    );
    assert.equal(service.settings().mixedPort, 17892);
    check("form edits persist through renderer IPC");
    await shot("settings");
    win.webContents.setZoomFactor(2);
    await wait("window.innerWidth < 700");
    await shot("settings-200-percent");
    win.webContents.setZoomFactor(1);
    await wait("window.innerWidth > 900");
    await win.webContents.reload();
    await wait("!!document.querySelector('.hero-title')");
    await js("document.querySelectorAll('.nav-item')[1].click()");
    await wait(
      "document.querySelector('[aria-label=\"本地代理端口\"]')?.value === '17892'",
    );
    check("saved settings survive reload");
    const invalid = await js(
      "window.aiGuard.saveSettings({..." +
        JSON.stringify(service.settings()) +
        ", mixedPort:0}).then(()=>false,()=>true)",
    );
    assert.equal(invalid, true);
    assert.equal(service.settings().mixedPort, 17892);
    check("invalid configuration rejected without overwriting settings");
    await js("document.querySelectorAll('.nav-item')[2].click()");
    await wait("document.querySelector('.checks')?.textContent.includes('Claude Code 线路') && document.querySelector('.checks')?.textContent.includes('Claude 看到的 IP')");
    assert.equal(await js("document.querySelectorAll('.checks li').length"), 2);
    check('Claude checks always show explicit unverified placeholders before manual inspection');
    await shot("doctor");
    assert.equal(await js("document.querySelector('.primary').disabled"), true);
    check("doctor requires running kernel");
    await js("document.querySelectorAll('.nav-item')[3].click()");
    await wait("!!document.querySelector('.log')");
    await shot("logs");
    assert.equal((await service.call("scan")).length, 0);
    check("logs and rule scan");
    win.close();
    assert.equal(win.isDestroyed(), false);
    assert.equal(win.isVisible(), false);
    win.show();
    check("close hides window for tray residency");
    await assert.rejects(service.call("start"), /配置|填写/);
    check("incomplete connection rejected before kernel launch");
    if (process.argv.includes("--aiguard-smoke-kernel")) {
      // Only local fixture nodes: real mihomo process, no TUN or public connection.
      const sub = createServer((_req, res) => {
        res.end(
          "proxies:\n  - name: smoke-local\n    type: socks5\n    server: 127.0.0.1\n    port: 9\n",
        );
      });
      await new Promise((r) => sub.listen(0, "127.0.0.1", r));
      const freePort = async () => {
        const server = createServer();
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const port = server.address().port;
        await new Promise((r) => server.close(r));
        return port;
      };
      try {
        await service.call("saveSettings", {
          ...service.settings(),
          mode: "strict",
          tunEnabled: false,
          realtimeProtection: false,
          mihomoPath: "",
          mixedPort: await freePort(),
          controllerPort: await freePort(),
          airportUrl: `http://127.0.0.1:${sub.address().port}/sub`,
          residential: {
            server: "127.0.0.1",
            port: 9,
            username: "smoke",
            password: "p: # smoke",
          },
        });
        await service.call("start");
        assert.equal(service.worker.running, true);
        assert.ok(service.worker.corePid > 0);
        check(
          "bundled mihomo starts through desktop worker with local fixture subscription",
        );
        const pid = service.worker.corePid;
        let ordinary;
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          ordinary = await service.call('nodes');
          if (ordinary.nodes.some(n => n.name === 'smoke-local')) break;
          await new Promise(r => setTimeout(r, 100));
        }
        assert.ok(ordinary.nodes.some(n => n.name === 'smoke-local'));
        const automatic = ordinary.selected;
        await js("document.querySelectorAll('.nav-item')[0].click()");
        await wait("!![...document.querySelector('[aria-label=\"普通代理节点\"]')?.options ?? []].find(o=>o.value==='smoke-local')");
        await js(`(() => { const el=document.querySelector('[aria-label="普通代理节点"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'smoke-local'); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await js("[...document.querySelectorAll('[data-testid=ordinary-node-card] button')].find(b=>b.textContent==='切换节点').click()");
        await wait("document.querySelector('[data-testid=ordinary-node-card]')?.textContent.includes('当前选择：smoke-local')");
        assert.equal((await service.call('nodes')).selected, 'smoke-local');
        await service.call('selectNode', automatic);
        check('ordinary node selector changes and verifies the real bundled core through UI and IPC, without TUN reload');
        await service.call("setMode", "global");
        assert.equal(service.settings().mode, "global");
        check("real mihomo hot reload");
        if (process.argv.includes("--aiguard-smoke-crash")) {
          writeFileSync(
            join(dataDir, "crash-ready.json"),
            JSON.stringify({ corePid: pid }),
          );
          // Runner force-kills only this UI PID; worker must independently reap its child.
          return;
        }
        await service.call("stop");
        assert.equal(service.worker.running, false);
        assert.throws(() => process.kill(pid, 0));
        check("owned mihomo terminates on stop");
      } finally {
        sub.close();
      }
    }
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = e.stack || e.message;
  }
  writeFileSync(
    join(dataDir, "smoke-result.json"),
    JSON.stringify(report, null, 2),
  );
  if (!report.ok) app.exit(1);
  else app.quit();
}
