# Provenance and attribution

This repository is a fork and a runtime integrator. It bundles no third-party
*analysis* source code, and it grants no third-party licenses. Every upstream
that contributed is listed here.

## Upstream chain

1. **REA — Reverse Engineer Anything** — <https://github.com/morluto/rea>, MIT.
   **Not bundled.** This project launches the published npm package at runtime:
   `npx -y rea-agents@<version> mcp`, and reads the JSON report of
   `npx -y rea-agents@<version> doctor` for its optional engine self-check (only
   the environment facts it reports — engine presence and remediation strings —
   are consumed). REA's own dependencies, licenses and analysis-engine
   requirements (Hopper, Ghidra, IDA Pro, JADX, Binwalk, …) apply to whoever runs
   it; this project installs none of them.

2. **dsh-rea** — <https://github.com/JeremyWangCY/dsh-rea>, MIT,
   Copyright (c) 2026 dsh-rea contributors.
   `lib/catalog.js` is copied verbatim, and `lib/index.js` began as a fork of
   its filtering bridge (namespace, tier curation, registration, rendering,
   timeout and non-fatal startup policy are its design). The `LICENSE` file in
   this repository is the upstream MIT text.

3. **DeepSeek Harness** — `@deepseek-ai/dsh-web-app`,
   `@deepseek-ai/dsh-agent-preset`, `@deepseek-ai/dsh-agent-preset-registry`,
   `@deepseek-ai/cordis`, … — MIT.
   `presets/reverse.patch.yml` reproduces the child-plugin row list of the
   shipped `standard` preset
   (`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`) so that the preset is
   a complete replacement rather than a merge. Those row ids, package names and
   configuration values are configuration metadata read from that MIT-licensed
   package; no source file is copied. The head of the file records this.

## This fork's own code

`lib/index.js` (fork modifications), `lib/guidance.js`, `lib/mcp-stdio.js`,
`lib/environment.js`, `scripts/doctor.mjs`, `presets/reverse.patch.yml`,
`test/**`, `README.md`, `HANDOFF.md`, `CHANGELOG.md`, CI configuration — MIT, see
[LICENSE](LICENSE).

## Trademarks and separate products

DeepSeek Harness / DSH belong to their authors; REA belongs to its authors.
Hopper, Ghidra, IDA Pro, JADX, Binwalk and Unblob are separate products under
their own licenses. Referring to them here is not a claim of affiliation, and
nothing in this repository grants a license to any of them.