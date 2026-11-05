// Executable protocol fixture. It models a foreign rule that must survive unlock.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.cwd(), 'fixture.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
writeFileSync(file, JSON.stringify(state));
if (state.mode === 'timeout') await new Promise(() => setInterval(() => {}, 1000));
if (state.mode === 'error') {
  process.stderr.write(JSON.stringify({ error: 'BFE access denied', code: 'ACCESS_DENIED' }));
  process.exit(5);
}
if (state.mode === 'malformed') { console.log('not JSON'); process.exit(0); }
if (state.mode === 'missingLocked') { console.log('{}'); process.exit(0); }
if (args[0] === 'stage-kernel') {
  const kernelPath = state.mode === 'badStagedPath' ? 'relative.exe' : join(process.cwd(), 'protected kernel', 'mihomo.exe');
  console.log(JSON.stringify({ locked: Boolean(state.rules.aiguard), complete: true, kernelPath }));
  process.exit(0);
}
if (args[0] === 'prepare-runtime') {
  console.log(JSON.stringify({ locked: Boolean(state.rules.aiguard), complete: true, runtimeDir: join(process.cwd(), 'protected kernel', 'runtime-123') }));
  process.exit(0);
}
if (args[0] === 'write-config') {
  let contents = '';
  for await (const chunk of process.stdin) contents += chunk;
  state.config = { path: join(args[2], args[4]), contents };
  writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify({ locked: Boolean(state.rules.aiguard), complete: true, path: state.config.path }));
  process.exit(0);
}
if (args[0] === 'lock' && state.mode !== 'ignore') state.rules.aiguard = [args[2], 'ipv4', 'ipv6'];
if (args[0] === 'unlock' && state.mode !== 'ignore') delete state.rules.aiguard;
writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify({ locked: Boolean(state.rules.aiguard) || state.mode === 'partialInstalled', complete: !['partial', 'partialInstalled'].includes(state.mode), owner: 'aiguard', available: true }));
