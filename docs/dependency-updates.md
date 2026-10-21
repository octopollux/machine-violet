# Dependency refresh (October 2026, #794)

This is a broad main-branch refresh, including stable major upgrades, rather
than a minimum security patch. Versions below were checked against npm's
publisher-provided `latest` metadata on 2026-10-21. The lockfiles are the exact
resolved dependency record; both the root workspace lock and campaign-explorer's
standalone lock are maintained.

## Significant upgrades

| Area | Previous direct requirement | Refreshed requirement |
| --- | --- | --- |
| Anthropic SDK | 0.115.0 | 1.0.0 |
| OpenAI SDK / Codex app-server | 6.49.0 / 0.160.0 | 7.41.0 / 0.163.0 |
| Google Gen AI SDK | 2.13.0 | 2.30.0 |
| React / Ink / ink-scroll-view | 19.2.0 / 7.0.0 / 0.3.6 | 19.3.1 / 8.0.0 / 0.4.0 |
| Fastify | 5.8.5 | 5.12.7 |
| Fastify CORS / Swagger / WebSocket | 11.0.0 / 9.7.0 / 11.0.0 | 11.3.1 / 9.9.2 / 11.3.4 |
| Scalar API reference | 1.49.7 | 1.75.1 |
| Sharp | 0.35.1 | 0.35.5 |
| isomorphic-git | 1.37.1 | 1.44.3 |
| dotenv / chokidar | 17.4.2 / 5.0.0 | 18.0.8 / 6.0.0 |
| Express / cors | 5.1.0 / 2.8.5 | 5.3.0 / 2.8.6 |
| Vitest / V8 coverage | 4.0.18 | 5.0.5 |
| Vite / React plugin | 8.0.x / 6.0.x | 8.3.5 / 6.1.2 |
| ESLint / typescript-eslint | 10.0.0 / 8.56.0 | 10.13.0 / 8.72.0 |
| TypeScript / Node types | 6.0.3 / 25.9.3 | 6.0.3 / 26.6.5 |
| esbuild / tsx | 0.28.1 / 4.x | 0.28.2 / 4.23.15 |

Other direct requirements, including workspace duplicates and browser-tool React
types, are aligned to their latest stable versions. PDF libraries remain
pdf-parse 2.4.5 and pdf-lib 1.17.1 because those are still their latest releases.
Postject remains 1.0.0-alpha.6, its existing and latest published version; this
refresh does not opt into newer prerelease channels.

## Deliberate compatibility boundaries

- TypeScript 7.0.2 is published, but typescript-eslint 8.72.0 declares support
  for `>=4.8.4 <6.1.0`. Retain the latest supported TypeScript 6 release (6.0.3)
  rather than force an unsupported lint/parser pairing. Revisit when the parser
  supports 7.x. No peer-dependency bypass was added.
- ink-scroll-view 0.4.0 still declares an Ink 7 peer. The existing targeted
  root override is retained and now resolves it to Ink 8. This is an explicit
  integration compatibility choice, not an upstream support claim; the TUI
  suite and packaged rendering checks must continue to guard it.
- Ink 8 exposes generic streams rather than assuming TTY streams. Inline image
  placement treats terminal rows as optional and keeps the non-TTY fallback.
- Anthropic SDK 1 models system messages as a separate union member. Cache
  stamping preserves that distinction without changing the outbound payload.
- Vitest 5 uses Vite as a peer; Vite is now an explicit root development
  dependency. Tests use its new default mock-call clearing behavior. Config
  paths use native ESM `import.meta.dirname`.

## Security interpretation and validation

GitHub reported 40 open Dependabot alerts (3 critical, 20 high, 15 medium,
2 low) across the root and nested lockfiles, not 40 distinct packages or a
measured root npm audit count. Updating direct dependencies left three stale
compatible transitive resolutions in the root npm audit;
`npm audit fix` advanced brace-expansion to 5.0.12, fast-uri to 3.1.9, and
find-my-way to 9.10.0. Root full and production-only npm audits then reported
zero vulnerabilities; the regenerated standalone campaign-explorer lock also
reported zero. These are point-in-time advisory database results, not a proof
that all dependencies are vulnerability-free.

The audit includes development dependencies; an entry is not evidence that a
player can reach the affected operation. Fastify and its URI/router chain are
runtime server dependencies. Brace expansion is in the development lint/tooling
chain. Both classes are refreshed instead of relying on presumed lack of
reachability. No ignored advisory or broad security override was introduced.

Validation completed locally:

- Full lint/test gate: 238 test files, 4,127 passed tests, 14 existing skips.
- Root typecheck and both browser-tool production builds passed.
- Deterministic golden verification: 14 passed, 14 skipped; source boot passed.
- Targeted Anthropic/image/campaign-explorer checks: 20 files, 180 tests passed.
- Focused TUI modal/image/phase checks: 24 files, 370 tests passed; explicit
  narrative scrolling and mouse-scroll checks: 2 files, 33 tests passed.
- The final built Windows SEA reported Node 26.12.1 and OpenSSL 3.5.9. Its direct and cross-signed eMudhra
  certificate probes both returned `CERT_REVOKED`, and its full-stack packaged
  replay produced 111 matching narrative lines after the SBOM-emitting rebuild.
  Its generated CycloneDX SBOM contains 436 components, including all six
  workspace components, with no unresolved dependency references. Four focused
  runtime diagnostic tests passed. The stable Windows Terminal 1.25.2733.0
  portable asset passed its pinned SHA-256 and flattened-layout checks without
  launching the terminal.

The retry-countdown test explicitly flushes React's effect/state work with
`act` around fake-timer advances and checks each second, rather than relying on
incidental scheduler timing. No live provider calls were needed for these gates.

macOS/Linux packaging, platform signing, interactive installer/install-method
smoke, and publishing have not been run as part of this local validation.
Passing these checks does not establish release readiness or replace those
platform and installation gates.

Upstream compatibility references:

- [Ink 8 release notes](https://github.com/vadimdemedes/ink/releases/tag/v8.0.0)
- [Vitest 5 migration guide](https://vitest.dev/guide/migration/)
- [typescript-eslint publisher metadata](https://registry.npmjs.org/typescript-eslint/latest)
