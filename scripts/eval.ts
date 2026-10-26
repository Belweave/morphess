import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfig } from '../src/config.js';

/** Offline transport/tool smoke evaluation. This measures the harness, not coding intelligence. */
const workspace = await mkdtemp(join(tmpdir(), 'morphess-eval-'));
let requests = 0;
let maxPayloadBytes = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const buffer = Buffer.concat(chunks); maxPayloadBytes = Math.max(maxPayloadBytes, buffer.length);
  const payload = JSON.parse(buffer.toString('utf8'));
  if (request.url !== '/v1/chat/completions' || payload.model !== 'morphess-eval-1m') {
    response.writeHead(400); response.end(); return;
  }
  requests++;
  const written = payload.messages.some((message: { role: string }) => message.role === 'tool');
  const choice = written
    ? { delta: { content: 'Created the requested file.' }, finish_reason: 'stop' }
    : { delta: { tool_calls: [{ index: 0, id: 'eval-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'proof.txt', content: 'Morphess transport and coding tools work.\n' }) } }] }, finish_reason: 'tool_calls' };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ id: `eval-${requests}`, object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [{ index: 0, ...choice }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: `eval-${requests}`, object: 'chat.completion.chunk', created: 0, model: payload.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  response.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing fixture address');
try {
  const config = defaultConfig(workspace);
  config.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  config.model.id = 'morphess-eval-1m'; config.model.allowUnauthenticated = true;
  await writeFile(join(workspace, 'morphess.json'), JSON.stringify(config));
  const prompt = process.env.MORPHESS_EVAL_LARGE === '1' ? `Inspect this evidence and write proof.txt.\n${'context evidence '.repeat(175_000)}` : 'Write proof.txt to show coding tools work.';
  const started = performance.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), '-C', workspace, 'run', '-', '--json', '--request-id', 'offline-eval'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    child.once('error', reject);
    child.stdin.on('error', (error) => { errors += `stdin: ${error.message}\n`; });
    child.once('close', (code) => resolveResult({ code, stdout: output, stderr: errors }));
    child.stdin.end(prompt);
  });
  const file = await readFile(join(workspace, 'proof.txt'), 'utf8');
  const answer = JSON.parse(result.stdout);
  if (result.code !== 0 || requests !== 2 || !file.includes('coding tools work') || answer.submission.status !== 'done') throw new Error(`Offline evaluation failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ passed: true, kind: 'offline-cli-transport-and-tools', modelProfileContextWindow: config.model.contextWindow, requests, elapsedMs: Math.round(performance.now() - started), maxPayloadBytes, promptBytes: Buffer.byteLength(prompt), statement: 'Scripted fixture; no live model quality or advertised context capacity was evaluated.' }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(workspace, { recursive: true, force: true });
}
