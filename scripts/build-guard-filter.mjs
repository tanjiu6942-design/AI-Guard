import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('GuardFilter must be built on Windows x64');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'vendor', 'guard-filter');
const dotnet = process.env.DOTNET_EXE || (existsSync('C:\\Program Files\\dotnet\\dotnet.exe') ? 'C:\\Program Files\\dotnet\\dotnet.exe' : 'dotnet');
mkdirSync(output, { recursive: true });
execFileSync(dotnet, ['publish', join(root, 'native', 'GuardFilter', 'GuardFilter.csproj'),
  '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output,
  '-p:PublishSingleFile=true', '-p:DebugType=none'], { stdio: 'inherit', windowsHide: true });
// No filters are installed by the build or the ABI/policy self-test.
const selfTest = execFileSync(join(output, 'aiguard-guard-filter.exe'), ['--self-test'], { encoding: 'utf8', windowsHide: true });
if (JSON.parse(selfTest).ok !== true) throw new Error('GuardFilter self-test failed');
for (const name of ['EMERGENCY-UNLOCK.md', 'emergency-unlock.cmd']) {
  copyFileSync(join(root, 'native', 'GuardFilter', name), join(output, name));
}
console.log(`GuardFilter built and offline self-test passed: ${output}`);
