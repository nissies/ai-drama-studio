# Project Status

## Current phase

Public repository candidate ready for final Git/GitHub publication checks.

## Completed

- Isolated the Electron client from backend, admin, logs, data and deployment files.
- Defaulted optional backend traffic to localhost.
- Preserved local projects and user-configured text/image/video/TTS providers.
- Added public repository documentation and secret-safe ignore rules.
- Updated production dependencies until `npm audit --omit=dev` reports no known vulnerabilities.
- Added a least-privilege Windows GitHub Actions workflow.
- Published the requested cooperation contact email in README and SECURITY.

## In progress

- Final tracked-file review, first commit and GitHub publication.

## Known limitations and risks

- Cloud login, credits, platform models and updater require a separately operated backend.
- FFmpeg executables and optional pose models are not included.
- Windows installer packaging requires verified FFmpeg binaries and their notices.

## Test status

- `npm ci`: passed.
- `npm run typecheck`: passed.
- `npm test`: 109 tests passed in 37 files.
- `npm run test:desktop`: 97 tests passed.
- `npm run build:desktop`: passed.
- `npm run lint`: passed with 291 pre-existing formatting/name warnings and no errors.
- `npm audit --omit=dev --registry=https://registry.npmjs.org`: 0 vulnerabilities.
- Secret/domain scan: no production domains, private keys or token-shaped values found.
