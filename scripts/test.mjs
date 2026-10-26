import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Headless builds retain Node 22.19 support; native OpenTUI runs on Node 26.4+.
const [major, minor] = process.versions.node.split('.').map(Number);
const flags = major > 26 || (major === 26 && minor >= 4) ? ['--experimental-ffi'] : [];
const child = spawn(process.execPath, [...flags, fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
