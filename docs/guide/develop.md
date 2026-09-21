---
title: Development Guide
description: Getting started with Hypit development.
---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Node.js | 22.15+ | everything |
| pnpm | 10.33.x | workspace management; selected by the root `packageManager` field |
| Python | 3.10–3.13 | local WhisperX and OpenCV Managed Programs |
| uv | latest | Python environment management |
| ffmpeg / ffprobe | recent stable | media processing |
| Chrome / Chromium | managed by HyperFrames | local HyperFrames rendering |

Node.js and pnpm are the only hard requirements. The rest are needed only for live Builds.

## Daily workflow

```bash
corepack enable
pnpm install --frozen-lockfile # after pulling or changing dependencies
pnpm check            # TypeScript type-check
pnpm test             # full test suite
```

| Command | What it runs |
|---|---|
| `pnpm check` | `tsc -p tsconfig.json --noEmit` |
| `pnpm test` | package, service-adapter and repository-boundary tests through Node's test runner |

See [Testing](./testing.md) for environment-gated tests and test patterns.

## Local Python and the Analysis UI

WhisperX, OpenCV and the pinned `yt-dlp` are uv projects the Runtime builds on demand. uv prefers the
CPython builds it downloaded itself, so a machine that already manages Python with vfox, mise, asdf
or pyenv would otherwise grow a second, unrelated interpreter under uv's data directory.
`HYPIT_PYTHON` names the interpreter to build from instead:

```bash
# vfox; `vfox current python` reports which version this is
export HYPIT_PYTHON="${VFOX_HOME:-$HOME/.vfox}/sdks/python/bin/python3"
pnpm analysis:watch
```

Name the interpreter's path rather than a bare version: a version request like `3.13` still resolves
through uv's own preference order, which reaches for uv's downloads first. An explicit `UV_PYTHON`
is left alone, because it is uv's own variable. Setting either one does not rebuild an environment
that already exists: WhisperX and the pinned `yt-dlp` adopt the interpreter on their next run, while
an existing OpenCV environment has to be removed before it is built again.

The Analysis UI loads the workspace `.env` into the CLI children it starts, so a `HYPIT_PYTHON` kept
there also covers the Runtime preparation and Builds that `pnpm analysis` submits. Running `uv sync`
or `hypit runtime up` in a bare terminal needs the export instead (or `set -a; . ./.env; set +a`).

`pnpm analysis` starts the Analysis UI (`hypit analysis`); `pnpm analysis:watch` adds `node --watch`,
which restarts the process when a module under `packages/analysis/src` changes. Either way the
interface is served by Vite: styles are replaced in place and an interface code change reloads the
page by itself. Analysis, Workflow and Build state lives on the server and is restored from
`.hypit/` after a reload or restart, but work that was still running when the process stopped does
not continue.

## Repository layout

```text
hypit/
├── packages/              workspace packages
├── docs/                  VitePress documentation site
├── examples/              runnable example sources
├── services/              local media and transcription services
├── test/                  repository boundary tests and shared fixtures
├── package.json           root workspace manifest
├── pnpm-workspace.yaml    package, service and example-component workspaces
└── tsconfig.json          TypeScript config
```

## Guide contents

| Guide | Topic |
|---|---|
| [Making videos with an Agent](./skill.md) | Creative direction, service choices and editable projects |
| [Packages and Extension](./packages.md) | Component, model and service ownership; installation and sharing |
| [Adding an author package](./author-packages.md) | Step-by-step: new component, Surface, vocabulary and preview, activation |
| [Models and Providers](./providers.md) | Select accounts and APIs; develop a Model or Provider package |
| [Runtime](./runtime.md) | Profile, Workspace, execution and lifecycle boundaries |
| [Studio localization](https://github.com/hypit-ai/hypit/blob/main/packages/studio/LOCALIZATION.md) | Translate interface messages; load a local JSON file or an installed language pack |
| [Testing](./testing.md) | Test runner, patterns, examples, boundary tests |
| [Conventions](./conventions.md) | Naming, module boundaries, wire data, TypeScript config |
