
import asar from '@electron/asar';
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = 'D:/aiguard';
const staging = join(root, '.staging-asar');
if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

cpSync(join(root, 'desktop'), join(staging, 'desktop'), { recursive: true });
cpSync(join(root, 'dist/core'), join(staging, 'dist/core'), { recursive: true });
cpSync(join(root, 'gui/dist'), join(staging, 'gui/dist'), { recursive: true });
cpSync(join(root, 'rules'), join(staging, 'rules'), { recursive: true });
mkdirSync(join(staging, 'gui/src-tauri/icons'), { recursive: true });
cpSync(join(root, 'gui/src-tauri/icons'), join(staging, 'gui/src-tauri/icons'), { recursive: true });
cpSync(join(root, 'package.json'), join(staging, 'package.json'));

const dest = join(root, 'AI Guard/resources/app.asar');
await asar.createPackage(staging, dest);
rmSync(staging, { recursive: true, force: true });
console.log('Packed app.asar successfully!');
