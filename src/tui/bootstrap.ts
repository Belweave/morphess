import { spawn } from 'node:child_process';

/** Headless commands never enable native FFI or load the UI package. */
export async function bootstrapTerminal(): Promise<boolean> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 26 || (major === 26 && minor < 4)) throw new Error('The OpenTUI terminal requires Node 26.4 or later. Headless commands remain available separately.');
  if (process.execArgv.includes('--experimental-ffi') || /(?:^|\s)--experimental-ffi(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')) return false;
  const child = spawn(process.execPath, ['--experimental-ffi', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  const term = () => { child.kill('SIGTERM'); };
  const interrupt = () => {}; // The shared terminal delivers input/signals to the interactive child.
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
    return true;
  } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
}
