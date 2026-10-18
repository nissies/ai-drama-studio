# Project Status

## Current phase

Published as a public repository at https://github.com/nissies/ai-drama-studio.

## Completed

- Isolated the Electron client from backend, admin, logs, data and deployment files.
- Defaulted optional backend traffic to localhost.
- Preserved local projects and user-configured text/image/video/TTS providers.
- Added public repository documentation and secret-safe ignore rules.
- Updated production dependencies until `npm audit --omit=dev` reports no known vulnerabilities.
- Added a least-privilege Windows GitHub Actions workflow.
- Published the requested cooperation contact email in README and SECURITY.
- Built and smoke-tested the Windows x64 unpacked application with bundled FFmpeg.
- Published the unsigned installer in GitHub Release `v0.4.5`.

## In progress

- Publish the reviewed `v0.4.6` Windows installer and source update.

## Known limitations and risks

- Cloud login, credits, platform models and updater require a separately operated backend.
- Optional pose models are downloaded separately from their pinned official source.
- Source builds require FFmpeg on `PATH`; release packaging requires verified binaries and notices.
- The public installer is not code-signed and may show an unknown-publisher warning.
- The optional DWPose model is not bundled in the installer.

## Test status

- `npm ci`: passed.
- `npm run typecheck`: passed.
- `npm test`: 109 tests passed in 37 files.
- `npm run test:desktop`: 97 tests passed.
- `npm run build:desktop`: passed.
- `npm run lint`: passed with 291 pre-existing formatting/name warnings and no errors.
- `npm audit --omit=dev --registry=https://registry.npmjs.org`: 0 vulnerabilities.
- Secret/domain scan: no production domains, private keys or token-shaped values found.
- Packaged application smoke launch: passed.
- Installer SHA-256: `274C7273F6BF87F3E3E72E5B12C7F53A9BEB9E56A152DF989B4D34B464AB3FF7`.
- Release: https://github.com/nissies/ai-drama-studio/releases/tag/v0.4.5
- Optional runtime tests: 5 passed, including integrity failure and per-redirect host rejection.
- Pinned DWPose upstream file independently downloaded; size and SHA-256 match the manifest.
- `v0.4.6` installer built with bundled FFmpeg; SHA-256:
  `D70B3A0780EE95AFAC5A2D3EA09448771D92D109FE61C729B50742177D407386`.
