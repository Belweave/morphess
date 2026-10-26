import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { TextAttributes, destroyTreeSitterClient, type CapturedFrame } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { openDemoRuntime } from '../src/tui/demo.js';
import { TuiController } from '../src/tui/controller.js';
import { MorphessTui } from '../src/tui/app.js';

// These images rasterize native renderer cell captures from the real offline demo.
// They are documentation fixtures, not mockups or live-model performance evidence.
const directory = join(process.cwd(), 'docs/screenshots');
await mkdir(directory, { recursive: true });
const demo = await openDemoRuntime();
const controller = await TuiController.open(demo.runtime);
const setup = await createTestRenderer({ width: 120, height: 36, screenMode: 'alternate-screen', exitOnCtrlC: false, useMouse: false });
const app = new MorphessTui(setup.renderer, controller, { demo: true });
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Demo capture did not settle');
    await new Promise(resolve => setTimeout(resolve, 20)); await setup.renderOnce();
  }
  await setup.flush(); await setup.renderOnce();
}
async function capture(name: string): Promise<void> {
  await setup.renderOnce(); await setup.flush();
  const frame: CapturedFrame = setup.captureSpans();
  const w = 9; const h = 21;
  const elements: string[] = [];
  for (const [y, line] of frame.lines.entries()) {
    let x = 0;
    for (const span of line.spans) {
      const [br, bg, bb] = span.bg.toInts(); const [fr, fg, fb] = span.fg.toInts();
      const width = span.width * w;
      elements.push(`<rect x="${x}" y="${y * h}" width="${width}" height="${h}" fill="rgb(${br},${bg},${bb})"/>`);
      if (span.text.trim()) elements.push(`<text x="${x}" y="${y * h + 16}" fill="rgb(${fr},${fg},${fb})" font-weight="${span.attributes & TextAttributes.BOLD ? '700' : '400'}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${xml(span.text)}</text>`);
      x += width;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.cols * w}" height="${frame.rows * h}" font-family="Menlo, monospace" font-size="15" xml:space="preserve">${elements.join('')}</svg>`;
  await writeFile(join(directory, `${name}.png`), new Resvg(svg).render().asPng());
  await writeFile(join(directory, `${name}.txt`), setup.captureCharFrame().split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n');
}
try {
  await capture('welcome');
  await controller.send('Read the demo workspace and explain what is available.');
  await waitFor(() => controller.state.questions.length > 0);
  setup.resize(60, 20); await capture('question-narrow');
  setup.resize(120, 36);
  await controller.answer(controller.state.questions[0]!.id, 'Explain durable recovery');
  await waitFor(() => !controller.state.busy && controller.state.entries.some(entry => entry.role === 'assistant' && entry.text.includes('Ready to build')));
  await waitFor(() => setup.captureCharFrame().includes('scripted offline demo'));
  setup.mockInput.pressKey('b', { ctrl: true }); await capture('coding');
} finally {
  try { await app.close(); } finally { await setup.dispose(); await controller.close(); await destroyTreeSitterClient(); await demo.close(); }
}
console.log('Native offline-demo captures written to docs/screenshots');
