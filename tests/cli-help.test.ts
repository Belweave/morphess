import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, type OutputConfiguration } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCli } from '../src/cli.js';
import { configureCliHelp } from '../src/cli/help.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function cli() {
  const program = createCli(); configureCliHelp(program);
  return program;
}
function outputHelp(command: Command): string {
  let output = '';
  command.configureOutput({ writeOut: text => { output += text; }, getOutHasColors: () => false, getOutHelpWidth: () => 100 });
  command.outputHelp();
  return output;
}
function intercept(program: Command, configuration: OutputConfiguration): void {
  program.exitOverride().configureOutput(configuration);
  for (const command of program.commands) intercept(command, configuration);
}

describe('operational CLI help', () => {
  it('groups commands around setup, coding, sessions and integrations and exposes a usable start workflow', () => {
    const help = outputHelp(cli());
    for (const heading of ['Setup:', 'Coding:', 'Sessions:', 'Integrations:']) expect(help).toContain(heading);
    expect(help.indexOf('Setup:')).toBeLessThan(help.indexOf('Coding:'));
    expect(help).toContain('morphess init'); expect(help).toContain('morphess doctor');
    expect(help).toContain('cat task.txt | morphess run -'); expect(help).toContain('--image'); expect(help).toContain('--trusted');
    expect(help).toContain('Ctrl+P'); expect(help).toContain('Escape'); expect(help).toContain('Ctrl+Q');
    expect(help.match(/independent, unofficial harness/g)).toHaveLength(1);
  });

  it('makes global workspace/security options and per-command examples available in command help', () => {
    const program = cli();
    const run = program.commands.find(command => command.name() === 'run')!;
    const help = outputHelp(run);
    expect(help).toContain('Global Options:'); expect(help).toContain('--workspace'); expect(help).toContain('--config'); expect(help).toContain('--trusted');
    expect(help).toContain('--request-id parser-fix --json'); expect(help).toContain('--session root --events');
    expect(help).toContain('host shell authority');
    const fork = outputHelp(program.commands.find(command => command.name() === 'fork')!);
    expect(fork).toContain('morphess fork root 123'); expect(fork).toContain('committed entry');
  });

  it('helps users recover from misspelled options before any runtime is opened', async () => {
    const open = vi.spyOn(MorphessRuntime, 'open').mockRejectedValue(new Error('Help must not open the runtime'));
    const program = cli(); let errors = '';
    intercept(program, { writeErr: text => { errors += text; }, writeOut: () => {}, getErrHasColors: () => false });
    await expect(program.parseAsync(['run', '--jso'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(errors).toContain('Did you mean --json?'); expect(errors).toContain('Usage: morphess run'); expect(errors).toContain('Examples:');
    expect(open).not.toHaveBeenCalled();
  });

  it('prints help without creating state, loading the terminal, or calling a model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-help-')); directories.push(directory);
    const open = vi.spyOn(MorphessRuntime, 'open').mockRejectedValue(new Error('Help must remain read-only'));
    const program = cli(); let output = '';
    const flags = [...process.execArgv];
    intercept(program, { writeOut: text => { output += text; }, writeErr: () => {} });
    await expect(program.parseAsync(['-C', directory, 'tui', '--help'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    expect(output).toContain('Node 26.4+'); expect(open).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
    expect(process.execArgv).toEqual(flags);
  });

  it('covers later integration commands and remains idempotent when configured again', () => {
    const program = new Command('morphess').option('-C, --workspace <path>', 'workspace');
    const tools = program.command('tools').argument('[name]').option('--all').option('--schema').option('--json').option('--session <id>');
    configureCliHelp(program);
    const mcp = program.command('mcp'); mcp.command('resources'); const nestedTools = mcp.command('tools');
    configureCliHelp(program);
    expect(mcp.helpGroup()).toBe('Integrations:');
    expect(outputHelp(tools)).toContain('morphess tools codemode --json --schema');
    expect(outputHelp(mcp.commands[0]!)).toContain('morphess mcp resources --help');
    expect(outputHelp(nestedTools)).toContain('morphess mcp tools --help');
    expect(outputHelp(program).match(/Workflow:/g)).toHaveLength(1);
  });
});
