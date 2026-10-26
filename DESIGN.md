# Morphess terminal design

The terminal is an operating surface. Its job is to make a coding conversation, tool evidence and recoverable work legible. Preserve familiar terminal controls; use the official Morph mark and green as the signature rather than decorative chrome.

## Direction contract

- **Character:** precise, calm, responsive. The user's code and the agent's evidence dominate.
- **Composition:** a compact header, streaming transcript, multiline composer anchored above a one-line keyboard/status footer. A 30-column inspector is optional and hides below 110 columns. Dialogs remain keyboard-searchable. At 60 columns and 18 rows, the composer and recovery actions still fit.
- **Brand:** the official Morph emblem is sampled into ASCII from the SVG bundled in assets/brand. Its source and digest are recorded. It is green at launch, not a generated approximation. The harness name remains Morphess.
- **Affiliation:** a persistent header identifies Morphess as independent, unofficial, and not Morph-backed. README, CLI help, terminal help, and brand provenance carry the same distinction.
- **Type:** terminal-selected monospace, one cell scale; bold identifies speakers/actions, muted labels hold metadata. No text uses low-contrast dim styling for essential controls.
- **Color:** forest ground #101810, surface #152219, selection #254831, foreground #e1efe4, muted #a1b9a8, border #355642, Morph mark #00eb81, action green #80ee64, warning #f0c77a, error #ff9d9d. Light and high-contrast palettes retain semantic roles and explicit text labels.
- **Geometry:** single-cell boundaries only where they explain grouping or focus. Transcript turns use spacing and labels rather than nested boxes. The composer owns the strongest boundary.
- **Feedback:** stream updates coalesce at most every 40 ms; completed messages retain native renderable identity. No perpetual idle animation. Work status changes through words and glyphs, never color alone.
- **Selection:** searchable command/session/tool lists; selected rows receive a filled surface and an explicit cursor. Escape closes transient surfaces before aborting work. Ctrl+C aborts current work first; Ctrl+Q leaves recoverable work and exits.
- **Density:** real context/model/session state replaces decorative counters. Tool output is compact by default and inspectable. Large transcripts are bounded in the view; full history remains durable.

## Selective references

OpenTUI's native layout, textarea, scroll box, markdown and testing APIs supply the surface. From pk, retain draft continuity, explicit tool inspection, theme roles and the principle that unrelated shell updates must not recreate transcript nodes. Do not transplant pk's provider engine, broad UI hierarchy or branding.

The Impeccable operating-surface exercise reinforces catalog-like scanning, direct status labels, and stable row identity; its decorative poster/map alternatives do not fit terminal work. The user-pinned Morph asset, green launch art and conventional coding workflow govern the implementation. No web mockup or invented terminal screenshot is the design authority.
