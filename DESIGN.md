# Terminal interaction contract

- Layout: compact session header, transcript, multiline composer, and status/keyboard footer. The optional inspector hides below 110 columns. Narrow layouts retain submission, question, and recovery controls.
- Navigation: command/session/tool/file menus are searchable. Escape closes a transient surface before aborting work. Ctrl+C stops work or exits when idle; Ctrl+Q closes the UI while preserving accepted work.
- Rendering: native Pi watches feed at most 80 display rows with 24,000-character message previews and 64,000-character tool details. Updates coalesce every 40 ms. Unchanged completed rows retain renderable identity.
- Safety: displayed source, questions, paths, status, and errors exclude terminal control sequences. The durable transcript retains original model/user content.
- State: mode, plan, questions, and task results come from native Pi documents/events. The UI owns only presentation and its private bounded preferences.
- Appearance: forest, light, and contrast themes use semantic roles with text labels for status. The terminal controls fonts and character scale.
- Identity: use the bundled Morph mark with provenance retained under `assets/brand`. Morphess remains visibly independent, unofficial, and not developed, endorsed, sponsored, or backed by Morph.
