# Release security refresh (#794)

This is a focused backport onto the released 1.1.1 tree, not promotion of main's
feature changes or broad dependency-major refresh. Rebuild shipped executables:
updating a lockfile cannot replace their embedded Node/OpenSSL trust data.

## Scope

- Node builder/CI/packaged runtime pinned to 26.12.1; Node types 26.6.5.
- Fastify 5.12.7, Sharp 0.35.5, Express 5.3.0, Vitest/coverage 4.1.12.
- Concurrently 10.0.6 and Vite 8.3.5 remove remaining npm audit findings.
- Both root and campaign-explorer locks refresh the affected transitive packages:
  fast-uri, PostCSS, source-map-js, proxy-addr, shell-quote, brace-expansion,
  smol-toml, @vitest/mocker, qs, nanoid, find-my-way and body-parser.
- Identical runtime diagnostic, certificate gate, SBOM/runtime inventory, CI pin,
  and Windows Terminal 1.25.2733.0 changes as main's security update.

Provider SDKs and Codex remain at the released versions; so do Ink 7.0.6,
ink-scroll-view 0.3.7, React/React DOM 19.2.7 and TypeScript 6.0.3. Main's SDK,
Ink 8, React 19.3 and Vitest 5 migrations are deliberately not part of this
security backport. TypeScript 7 is deferred on both branches because the current
typescript-eslint peer range excludes it. No campaign format or game feature changes.

## Exposure and evidence

Fastify, schema tooling, Sharp and Scalar are production engine dependencies.
Express/proxy-addr/qs/body-parser belong to the explorer/editor development tools,
not the shipped engine; a lockfile's runtime label alone does not prove packaged
reachability. PostCSS/source-map-js and Vitest are development tooling. Shell-quote
is also reachable through Ink's optional React DevTools dependency, so its scope
should not be described unconditionally as development-only.

Local Windows verification on 2026-10-21:

- Root full and production-only npm audits: zero findings; standalone explorer
  lock audit: zero findings.
- Typecheck and lint passed. Full check: 213 test files passed, 3929 tests passed,
  14 skipped. Offline runtime diagnostics: four tests passed.
- Explorer and theme-editor Vite production builds and server typechecks passed.
- Actual Windows SEA build reports Node 26.12.1, OpenSSL 3.5.9, Undici 8.12.2,
  SQLite 3.54.0; packaged quickstart replay matches all 111 narrative lines.
- Final actual SEA rejects both direct and cross-signed incident certificate
  chains specifically with `CERT_REVOKED`. CycloneDX 1.5 SBOM has 438 components.

Signing, Velopack installation, macOS/Linux artifact checks and the interactive
install-method release smoke are not implied by this local portable-build result.
No release is cut by preparing this patch.
