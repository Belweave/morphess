# Morphess

Morphess extends @earendil-works/pi-durable; keep Pi's durable task, conversation, and tool machinery as the source of truth. Do not build a second agent loop or replay completed side effects.

Use TypeScript ESM, strict types, .js import specifiers, npm, and Node >=22.19.0. Run `npm run check` before pushing. Keep tests offline using Pi's faux provider or a local HTTP fixture. Never commit credentials, model payloads from real users, or session databases.

Keep concurrency bounded (tests use two workers). Extensions must state replay safety, and non-idempotent effects must never be marked replay safe. Filesystem policy is defense in depth; shell execution requires an explicit trust decision or an isolated backend.

On this Mac, use Xcode 27.1 Release Candidate (build 27A9275) globally for Apple-platform projects until a newer stable Xcode release is available. Verify the installed version before building; do not fall back to an older beta silently. Prefer local builds, bounded concurrency, and disk-backed build storage. Coordinate large builds with other active projects to avoid memory pressure.
