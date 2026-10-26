import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { destroyTreeSitterClient, TextAttributes, type CapturedFrame, type RGBA } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { MorphessTui } from '../src/tui/app.js';
import { TuiController } from '../src/tui/controller.js';
import { defaultPreferences } from '../src/tui/preferences.js';
import { THEMES } from '../src/tui/theme.js';

// Capture the production view and controller against a fresh, temporary Pi
// runtime. No prompt is submitted, provider called, or existing session opened.
const workspace = await mkdtemp(join(tmpdir(), 'morphess-'));
let runtime: MorphessRuntime | undefined;
let controller: TuiController | undefined;
let setup: TestRendererSetup | undefined;
let app: MorphessTui | undefined;
try {
  runtime = await MorphessRuntime.open(defaultConfig(workspace));
  controller = await TuiController.open(runtime);
  setup = await createTestRenderer({
    width: 120, height: 36, screenMode: 'alternate-screen', exitOnCtrlC: false,
    exitSignals: [], kittyKeyboard: true, useMouse: false, backgroundColor: THEMES.forest.background,
  });
  app = new MorphessTui(setup.renderer, controller, { preferences: defaultPreferences(), launchMark: true });
  await setup.waitFor(() => controller!.state.status === 'Ready' && controller!.state.context !== undefined);
  await setup.renderOnce();
  await setup.flush({ maxPasses: 80 });
  await setup.renderOnce();
  const frame = setup.captureSpans();
  const output = fileURLToPath(new URL('../assets/screenshots/tui-default.png', import.meta.url));
  await mkdir(dirname(output), { recursive: true });
  const raster = new Resvg(frameSvg(frame), {
    fitTo: { mode: 'width', value: 2400 }, font: { defaultFontFamily: 'Menlo', loadSystemFonts: true },
  }).render();
  await writeFile(output, raster.asPng());
  console.log(`Captured the default TUI: ${output} (${raster.width} × ${raster.height})`);
} finally {
  try { await app?.close(); }
  finally {
    try { await setup?.dispose(); }
    finally {
      try { await controller?.close(); }
      finally {
        try { await runtime?.close(); }
        finally {
          try { await destroyTreeSitterClient(); }
          finally { await rm(workspace, { recursive: true, force: true }); }
        }
      }
    }
  }
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function color(value: RGBA): string {
  const [red, green, blue, alpha] = value.toInts();
  return `rgba(${red},${green},${blue},${alpha / 255})`;
}

// Preserve the native renderer's exact cells, colors, and attributes. Rasterize
// its captured frame rather than constructing a separate view of the product.
function frameSvg(frame: CapturedFrame): string {
  const cellWidth = 10; const cellHeight = 23;
  const width = frame.cols * cellWidth; const height = frame.rows * cellHeight;
  const backgrounds: string[] = []; const foregrounds: string[] = [];
  for (const [row, line] of frame.lines.entries()) {
    let column = 0;
    for (const span of line.spans) {
      const x = column * cellWidth; const y = row * cellHeight; const spanWidth = span.width * cellWidth;
      backgrounds.push(`<rect x="${x}" y="${y}" width="${spanWidth}" height="${cellHeight}" fill="${color(span.bg)}"/>`);
      if (span.text.trim()) {
        const weight = span.attributes & TextAttributes.BOLD ? '700' : '400';
        const italic = span.attributes & TextAttributes.ITALIC ? 'italic' : 'normal';
        foregrounds.push(`<text x="${x}" y="${y + 17}" fill="${color(span.fg)}" font-weight="${weight}" font-style="${italic}" textLength="${spanWidth}" lengthAdjust="spacingAndGlyphs">${xml(span.text)}</text>`);
      }
      column += span.width;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${THEMES.forest.background}"/><g font-family="Menlo,monospace" font-size="16" xml:space="preserve">${backgrounds.join('')}${foregrounds.join('')}</g></svg>`;
}
