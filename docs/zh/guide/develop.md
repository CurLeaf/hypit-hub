---
title: 开发指南
description: 开始 Hypit 开发工作。
---

## 前置条件

| 工具 | 版本 | 用于 |
|---|---|---|
| Node.js | 22.15+ | 所有工作 |
| pnpm | 10.33.x | workspace 管理；由根目录 `packageManager` 字段选择 |
| Python | 3.10–3.13 | 本地 WhisperX 与 OpenCV Managed Program |
| uv | latest | Python 环境管理 |
| ffmpeg / ffprobe | 较新的稳定版 | 媒体处理 |
| Chrome / Chromium | 由 HyperFrames 管理 | 本地 HyperFrames 渲染 |

只有 Node.js 与 pnpm 是硬性要求。其余都只在跑真实 Builds 时才需要。

## 日常工作流

```bash
corepack enable
pnpm install --frozen-lockfile # 拉取代码或改动依赖之后
pnpm check            # TypeScript 类型检查
pnpm test             # 完整测试套件
```

| 命令 | 实际执行什么 |
|---|---|
| `pnpm check` | `tsc -p tsconfig.json --noEmit` |
| `pnpm test` | 通过 Node test runner 运行 package、service-adapter 与仓库边界测试 |

关于受环境开关控制的测试与测试写法，参见 [测试](./testing.md)。

## 本地 Python 与 Analysis UI

WhisperX、OpenCV 与固定版本的 `yt-dlp` 都是 Runtime 按需构建的 uv 工程。uv 优先使用自己下载的
CPython 构建，所以已经用 vfox、mise、asdf 或 pyenv 管理 Python 的机器，会多出一个位于 uv 数据目录
下的、与之无关的解释器。`HYPIT_PYTHON` 用来指定真正作为构建基础的解释器：

```bash
# vfox；`vfox current python` 可查看当前版本
export HYPIT_PYTHON="${VFOX_HOME:-$HOME/.vfox}/sdks/python/bin/python3"
pnpm analysis:watch
```

请写解释器路径，而不要只写版本号：`3.13` 这样的版本请求仍会走 uv 自己的优先级，而它先看自己下载的
构建。显式设置的 `UV_PYTHON` 不会被覆盖，因为那是 uv 自己的变量。设置任一变量都不会重建已经存在的
环境：WhisperX 与固定版本的 `yt-dlp` 会在下次运行时改用新解释器，而已经建好的 OpenCV 环境需要先
删除才会重建。

Analysis UI 会把工作区 `.env` 注入自己启动的 CLI 子进程，所以写进 `.env` 的 `HYPIT_PYTHON` 对
`pnpm analysis` 发起的 Runtime 准备与 build 同样有效；在终端直接跑 `uv sync` 或 `hypit runtime up`
时，需要先 export（或 `set -a; . ./.env; set +a`）。

`pnpm analysis` 启动 Analysis UI（即 `hypit analysis`）；`pnpm analysis:watch` 额外加上
`node --watch`，`packages/analysis/src` 下的模块改动会让进程自动重启。两种方式下界面都由 Vite
提供：样式原地替换，界面代码改动后浏览器自动刷新。分析、工作流与 Build 状态保存在服务端，刷新或
重启后会从 `.hypit/` 恢复；但进程停止时仍在运行的任务不会继续。

## 仓库结构

```text
hypit/
├── packages/              workspace packages
├── docs/                  VitePress documentation site
├── examples/              runnable example sources
├── services/              本地媒体与转写服务
├── test/                  repository boundary tests and shared fixtures
├── package.json           root workspace manifest
├── pnpm-workspace.yaml    package, service and example-component workspaces
└── tsconfig.json          TypeScript config
```

## 指南目录

| 指南 | 主题 |
|---|---|
| [与 Agent 一起制作视频](./skill.md) | 创作方向、服务选择与可编辑项目 |
| [包与扩展](./packages.md) | 组件、模型与服务的职责，安装与分享 |
| [添加 Author 包](./author-packages.md) | 分步说明：新增组件、Surface、词表与预览图、activation |
| [模型与 Provider](./providers.md) | 选择账户与 API，开发 Model 或 Provider 包 |
| [Runtime](./runtime.md) | Profile、Workspace、执行与生命周期边界 |
| [Studio 本地化](https://github.com/hypit-ai/hypit/blob/main/packages/studio/LOCALIZATION.md) | 翻译界面文案，加载本地 JSON 或已安装的语言包 |
| [测试](./testing.md) | 测试运行器、写法、示例、boundary tests |
| [代码规范](./conventions.md) | 命名、模块边界、wire 数据、TypeScript 配置 |
