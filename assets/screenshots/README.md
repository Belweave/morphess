# Terminal screenshot

`tui-default.png` captures Morphess's default 120 × 36 terminal view using the
production TUI, controller, and a fresh Pi Durable runtime. OpenTUI's native
render-buffer cells are rasterized to PNG with their original colors and text.
The forest theme and sidebar visibility use the default preferences.

Regenerate with Node 26.4+ and development dependencies installed:

```sh
TMPDIR=/tmp npm run screenshot:tui
```

The capture uses a temporary workspace and deletes its session database after
rendering. It does not load a user's sessions, submit a prompt, or call inference.
The Morph mark and unofficial status appear exactly as they do on launch;
trademark provenance is in [../brand/README.md](../brand/README.md).
