import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it('runs the CLI through an npm-style executable symlink from another working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-bin-')); directories.push(directory);
  const bin = join(directory, 'morphess');
  await symlink(resolve('src/cli.ts'), bin);
  const { stdout } = await execute(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, bin, '--version'], { cwd: directory });
  expect(stdout.trim()).toBe(VERSION);
  const help = await execute(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, bin, '--help'], { cwd: directory });
  expect(help.stdout).toContain('tui [options]');
  expect(help.stdout).toContain('independent, unofficial harness');
});

it('does not start the CLI when its module is imported', async () => {
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(resolve('src/cli.ts')).href)}); console.log('imported');`]);
  expect(stdout.trim()).toBe('imported');
});

it('enables native model and nested shell calls with the full-access CLI flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-access-')); directories.push(directory);
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), '-C', directory, '--full-access', 'tools', 'bash', '--json']);
  expect(JSON.parse(stdout)).toMatchObject({ policy: 'trusted', tools: [{ name: 'bash', offeredToModel: true, callableByTools: true, status: 'available' }] });
});
