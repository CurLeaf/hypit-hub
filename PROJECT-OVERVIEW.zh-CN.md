# Hypit 项目总览

这份文档用来建立一个清晰的心智模型：Hypit 是什么、它怎么工作、仓库里各部分分别负责什么，以及该按什么顺序读官方文档。

官网：[hypit.ai](https://hypit.ai) · 仓库：[github.com/hypit-ai/hypit](https://github.com/hypit-ai/hypit) · 当前版本见根目录 `package.json`。

---

## 1. 一句话定位

**Hypit 是一套给 AI Agent 用的视频制作语言和执行系统。**

它不是传统剪辑软件，也不是「输入一句提示词就出片」的生成器。它把一条视频表达成可编辑、可重跑的 **workflow**：剧本、画面、字幕、B-roll、特效都挂在**词和语义事件**上，而不是挂在秒数上。Agent（Claude Code、Codex、Cursor 等）读 Skill、写 Source、调 CLI，最后由 Runtime 执行成片。

复刻爆款是最快入口，不是唯一入口：可以从模板开始，也可以从描述从零写 workflow。生成模型也不是必需的——字幕、动效和代码渲染的画面可以不调用任何模型就编译成片，成本可以为 $0。

---

## 2. 它解决什么问题

短视频、信息流广告、带货、播客切片这类内容，真正贵的不是「渲一次」，而是：

1. 理解一条已经有效的视频**为什么有效**（哪句话出图、哪个词落字幕、哪个 Moment 揭晓答案）。
2. 把这套关系变成**可复用结构**：换主播、换产品、换语言、换画幅时，结构还在。
3. 让 AI Agent 能稳定执行：检查环境、要凭据、生成素材、组装时间线、渲染、复用已有产物。

传统时间轴是「第 3.2 秒切画面」。台词一改，整条时间轴就废。Hypit 的先验是：**先给时间轴语义，再由实际表演投影出时间。** 改一句台词，字幕、榜单动画、B-roll 仍跟着同一句话出现。

Slogan 层面的能力：

| 能力 | 含义 |
| --- | --- |
| Clone any video | 丢进一条视频，拿到完整 workflow，不是拆解脚本 |
| One workflow, 100 variants | 第二条几乎不花钱；换人脸 / 产品 / 语言只改相关 Source |
| Pluggable components | 换主播不必动字幕；用官方组件、fork，或自己写项目组件 |
| Open source, $0 工具费 | 无席位费、无按条渲染费、无水印；模型 API 费用另计 |

典型出品：信息流广告变体、TikTok/Reels 复刻、带货 SKU 替换、AI UGC 口播、播客/街头采访切片、纯代码渲染视频、多语言版本。

---

## 3. 三个必须分开的东西

很多困惑来自把下面三件事混成一个「Hypit」。它们各自安装、各自更新、各自有位置：

```text
┌─────────────────────────────────────────────────────────────┐
│  Skill（制作知识）                                            │
│  skills/hypit/SKILL.md + references/                         │
│  告诉 Agent：怎么理解参考片、怎么写 Brief/Treatment、           │
│  怎么选模型、怎么写 SVML、怎么审片                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ 指导 Agent 写文件、跑命令
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Distribution（可执行工具 + 官方包）                           │
│  `hypit` CLI、官方组件、公开 SDK、Local Runtime                │
│  npm 包 @hypit/hypit；入口 bin/hypit.mjs                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ 编译、规划、执行、预览
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  视频项目（作品本身，通常不在本仓库里）                          │
│  .svml / .svs / .svrun、assets、项目组件、                    │
│  hypit.runtime.json、.hypit/results                           │
└─────────────────────────────────────────────────────────────┘
```

- **Skill** 提供判断和流程；不渲染视频。
- **Distribution** 提供编译器和 Runtime；不知道你这条片子要讲什么。
- **视频项目** 才是作品：普通文件，可继续编辑、可交给别人、可重跑。

本仓库同时包含 Skill、Distribution 源码和示例项目。真正给用户做的片子，应放在仓库之外的独立目录。

用户侧一次安装：

```bash
npx skills add hypit-ai/hypit -g
```

首次使用时，Agent 会检查并协助准备 `hypit` 可执行程序。之后在任意项目目录：

```text
/hypit 复刻这个视频：/path/to/video
/hypit 做一个 ranking 视频，把 Hypit 排到 S 级。
```

---

## 4. 核心设计思想

摘自 `skills/hypit/references/production/system.md`：

> Give semantics to the timeline, rather than the timeline to semantics.
> Give layers to the canvas, rather than the canvas to layers.

### 4.1 语义时间，而不是秒

说话作品里，**Script 只写词，不写时间码**。时间来自实际表演（生成或导入的口播）经 WhisperX 对齐后的词级时间。

| 概念 | 是什么 | 例子 |
| --- | --- | --- |
| Segment | 一段连续语音块 | `<opening>`、`<ronaldo>` |
| Selection | Script 里的一个区间 | 某句吐槽对应的 B-roll |
| Moment | 一个点 | 揭晓排名、产品递出 |
| SemanticTake | 归一化媒体 + 某个 Segment 的词级对齐 | 一段 10 秒口播 |
| Timeline | 整条片子的完整时间范围 + Take 放置 | 可空隙、可重叠、也可以没有 Take |

A-roll 是**提供这段话及其局部时间的表演**。画面可以全屏、可以缩成小窗、可以被 B-roll 盖住；语义脊骨仍是这段口播。

### 4.2 组件是词表，不是插件杂烩

画面由组件贡献 **Track**。官方已有 Media / Performance / Sound / Caption / Ranking 等；新关系就写**项目组件**。共享布局和运动的放进同一个场景；独立字幕继续分开。

### 4.3 图执行，显式复用

Source 描述依赖图。Run 选出 Target（例如 `final.video`）。Runtime 只执行通向 Target 的闭包。

**没有隐式缓存。** 要复用上一次生成的主播视频，必须在 `.svrun` 里用 `<build-record>` + `<satisfy>` 写明。每次 `build` 都是新的 Build id。

### 4.4 职责切开

| 角色 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Model | 生成请求的含义和输出类型 | 怎么调 API、用谁的 Key |
| Provider / Endpoint | 把请求映射到某个服务 | 片子讲什么 |
| Author 组件 | 作者输入 → 素材请求或视觉行为 | 账户和部署 |
| Runtime Profile | Endpoint、凭据引用、容量 | 创作选择 |
| Core | 与领域无关的图编译和 Build 状态机 | 不知道什么是视频 |

---

## 5. 三种源文件

| 扩展名 | 处理指令 | 作用 |
| --- | --- | --- |
| `.svml` | `<?svml using="@hypit/markup@1"?>` | **Author Source**：片子本身——Script、生成、组件、合成 |
| `.svs` | Recipe | **可复用配方**：外观、Prompt Kit、表演方向 |
| `.svrun` | `<?svml using="@hypit/run-markup@1"?>` | **Run Source**：选哪份 Author、要哪些 Target、复用哪些已有 Output |

最小 Run：

```svml
<?svml using="@hypit/run-markup@1"?>

<svrun version="1">
  <author source="./main.svml"/>
  <target output="final.video"/>
</svrun>
```

推荐（非强制）项目布局：

```text
my-video/
  package.json              项目边界（CLI 向上找最近的 package.json）
  authors/main.svml
  recipes/visual.svs
  runs/final.svrun
  assets/
  packages/                 这部片子自己的组件
  hypit.runtime.json
  .hypit/                   Runtime 数据与 Results（勿提交）
```

Hypit **不**特殊识别这些目录名，只服从 import、`<author source>` 和 CLI 路径。

---

## 6. 一条视频怎么从源码变成成片

```text
Brief / Treatment / 参考片理解
        │
        ▼
 Script（词、Segment、Selection、Moment）
        │
        ├── 生成或导入：图片、语音、视频 Take、音乐
        │
        ▼
 归一化 +（说话作品）WhisperX 词级对齐
        │
        ▼
 SemanticTake 放入 Timeline
        │
        ▼
 组件消费语义事件，产出 Visual / Audio Track
 （Performance、Caption、Ranking、项目场景……）
        │
        ▼
 Film 组装 Track → Composition
        │
        ▼
 HyperFrames（无头 Chromium）渲染 → MP4
```

生成可以和组件开发并行。素材到位后再看层次、时机、字幕是否跟得上词。

Agent 制作循环（用户视角）：

1. 安装 Skill，打开视频项目。
2. 给参考片或描述，说明要改什么。
3. 选择服务：HypiHub 托管，或 BYOK / 本地 WhisperX。
4. `plan` / `pricing` 看范围和费用，确认后再 `build`。
5. 看成片；用 Studio 调组件属性，或继续对话改 Source。
6. 变体通过新的 `.svrun` 显式复用已有 Output。

---

## 7. CLI 与 Runtime

命令入口：`hypit`（`bin/hypit.mjs`，由 `@hypit/video-cli` 组装官方视频 Distribution）。

| 阶段 | 命令 | 做什么 |
| --- | --- | --- |
| 环境 | `runtime init` / `runtime use` | 写/选择 `hypit.runtime.json` |
| 环境 | `auth login` / `auth status` | 凭据进 Credential Store，不写进 Source |
| 环境 | `doctor` / `runtime up` | 诊断；准备本地依赖并启动 Worker |
| 创作 | `transcribe` / `measure` | 转写参考片；估 Segment 时长（`measure` 不花钱） |
| 图 | `check` / `plan` / `pricing` | 校验源码、展示将执行的请求和费率 |
| 执行 | `build --follow` | 提交一次 Build；关终端不会取消 |
| 观察 | `status --watch` / `logs` / `activity` | 观察 Worker，不是执行者 |
| 产物 | `inspect` / `get` / `history` / `builds` | 读 Result；导出文件 |
| 预览 | `studio --run …` | 浏览器时间线与 Comments |

要点：

- `build` 不做部署准备；依赖必须事先 `runtime up`。
- `--follow` 只是观察；取消用 `hypit cancel <build-id>`。
- Result 默认在 `.hypit/results/<日期>/<build-id>/`。
- Profile 示例：HypiHub 负责托管生成和 WhisperX，本地负责媒体处理和渲染。

---

## 8. 仓库地图

本仓库是 **pnpm workspace monorepo**（Node 22.15+、pnpm 10.33、TypeScript 5.9）。

```text
hypit/
├── packages/           全部 TypeScript 包（核心、组件、Provider、Studio……）
├── services/           本地 Python Managed Program（whisperx / image-opencv / yt-dlp）
├── skills/hypit/       Agent Skill 与制作参考
├── docs/               VitePress 文档（docs/ 英文，docs/zh/ 中文）
├── examples/           可运行示例项目
├── test/               仓库边界测试与共用 fixture
├── bin/hypit.mjs       CLI 入口
├── package.json        根 Distribution 清单与公开子路径导出
└── pnpm-workspace.yaml packages/* + services/* + examples/*/packages/*
```

根 `package.json` 的 `exports` 是对外 SDK 表面，例如 `@hypit/hypit/author-kit`、`@hypit/hypit/model-kit`。外部扩展依赖选定版本的 `@hypit/hypit`，不要直接依赖内部 workspace 包名（开发本仓库除外）。

### 8.1 包怎么分层

**执行内核（不知道「视频」是什么）**

| 包 | 职责 |
| --- | --- |
| `core` | 图编译与 Build 状态机 |
| `protocol` | 跨包协议类型 |
| `cli` | 领域无关命令引擎 |
| `video-cli` | 官方视频 CLI：接上 Markup 编译器和 Local Runtime |
| `compiler-node` / `compiler-markup-node` | 把 Source 编成图 |
| `source` / `markup` / `run` / `run-markup` / `svs` | 源语言与 Run |
| `runtime` / `runtime-local` / `runtime-kit` / `runtime-host-node` | 执行 |
| `build-result` / `build-result-fs` / `build-result-s3` | 产物仓库 |
| `credential-store-env` / `credential-store-os` | 凭据 |
| `store-sqlite` | Runtime 状态 |
| `workspace` / `package-loader-node` / `driver-node` / `host` | 加载与 Host |

**作者 SDK 与领域值**

`author-kit`、`component-kit`、`model-kit`、`endpoint-kit`、`studio-adapter`、`program-space`、`visual-ir`、`temporal`、`spatial`、`composition`、`generation`、`text`、`narrative`

**官方作者组件（Source 里 import 的那些）**

| 包 | 角色 |
| --- | --- |
| `script` | 散文优先的剧本 |
| `timeline` / `timeline-author` | 时间轴与放置 |
| `media` / `media-pipeline` / `media-track` | 素材声明、处理、呈现 |
| `performance` / `sound` / `audio-track` | 表演画面、时间轴声音、独立音轨 |
| `caption` / `caption-fine` | 词级字幕与细样式 |
| `ranking` / `comment-sticker` / `screen-overlay` / `deck-track` / `typography-track` | 榜单、评论贴纸、叠加、演示文稿、排印 |
| `film` / `hyperframes` / `render-hyperframes` | 合成与 Chromium 渲染 |
| `speech` / `whisperx` / `estimate` | 语音、对齐、时长估算 |
| `browser-capture` | 网页录制 |
| `fonts-open` | 开源字体 |

**模型包与 Kit**

`gpt-image`、`gpt-image-kits`、`seedance`、`seedance-kits`、`seedream`、`nano-banana`、`grok-imagine`、`fishaudio-speech`、`elevenlabs-speech`、`mimo-speech`、`minimax-h3`、`yt-dlp`、`volcengine-matting`、`background-removal`、`image-compose`、`image-transform`

**Provider**

`provider-hypihub`（托管）、`provider-media-local`、`provider-hyperframes-local`、`provider-whisperx-local`、`provider-image-opencv-local`

**Studio**

`studio` 本体，以及各组件的 `*-studio` Companion（时间线实体和可编辑属性）。

带 `-studio` 后缀的包只服务编辑器，不参与成片图。

### 8.2 示例项目

| 示例 | 学什么 |
| --- | --- |
| [examples/ranking-football](examples/ranking-football/README.md) | 独立口播 Take、持久榜单、按词揭晓 |
| [examples/podcast](examples/podcast/README.md) | 双人机位、产品参考、动机剪辑、生活方式蒙太奇 |
| [examples/interview](examples/interview/README.md) | 共享遭遇、派生近景、协同 Moment、字幕跟脸 |
| [examples/complex-explainer](examples/complex-explainer/README.md) | 137 秒讲解：项目场景、移动主播取景、无 Take 区间 |
| [examples/semantic-composition](examples/semantic-composition/README.md) | 响应式场景、聊天 UI、样式包 |
| [examples/minimal-author-package](examples/minimal-author-package/README.md) | 最小可构建组件包 |
| [examples/provider-package](examples/provider-package/README.md) | 项目 Provider 怎么接一个服务 |

前三个生成示例是完整闭环：`reference.svml` + `reference.svrun`，不依赖更早的 Result。`swap-*` 子目录是变体研究，生成标准不一定与 reference 一致。

把示例拷到仓库外使用时，拷整个示例目录；官方包仍由已安装的 Distribution 提供。

---

## 9. Skill 里的「房间」

Agent 不是把整本手册读完再开工。`skills/hypit/SKILL.md` 按当前问题指向 `references/`：

| 房间 | 目录 | 何时进去 |
| --- | --- | --- |
| Environment | `references/environment/` | 安装、Profile、模型/Provider、本地工具 |
| Creation | `references/creation/` | 参考片、Brief、变形、Script、项目文件 |
| Production | `references/production/` | 系统关系、作者语法、时间轴、Build、Studio、渲染 |
| Playbooks | `references/playbooks/` | 体裁（ranking / 播客 / 街头采访……）和工艺（画面、声音、字幕、合成） |

制作一条片子会在这些房间之间来回，而不是走一条固定流水线。

---

## 10. 按角色的阅读路径

仓库和官网文档已经很多。下面按目标选出**最小充分集合**，避免从 `packages/` 随机点进去。

### 路径 A — 我只想搞清「这是什么」（30 分钟）

1. [README.zh-CN.md](README.zh-CN.md) — 产品叙事与示例成片
2. 本文第 1–6 节
3. [examples/README.md](examples/README.md) — 四个主示例各自教什么
4. 打开一个 `reference.svml`（建议 `examples/ranking-football/reference.svml`），对照 import 列表看片子是怎么声明的

### 路径 B — 要用 Agent 做视频（用户）

按顺序读 `docs/zh/`（与 [hypit.ai/zh/quickstart](https://hypit.ai/zh/quickstart/) 同步）：

| 顺序 | 文档 | 你将得到 |
| --- | --- | --- |
| 1 | [docs/zh/quickstart.md](docs/zh/quickstart.md) | 安装 Skill、给参考、选服务、确认费用、看成片 |
| 2 | [docs/zh/guide/skill.md](docs/zh/guide/skill.md) | Agent 如何理解参考、写 Brief/Treatment、保持项目可编辑 |
| 3 | [docs/zh/quickstart/run.md](docs/zh/quickstart/run.md) | `.svrun`、显式复用、Runtime、`plan`/`build`/`get` |
| 4 | [docs/zh/quickstart/preview.md](docs/zh/quickstart/preview.md) | Studio 与 Comments |
| 5 | 按需要：[script](docs/zh/quickstart/script.md) · [generation](docs/zh/quickstart/generation.md) · [timing](docs/zh/quickstart/timing.md) · [tracks](docs/zh/quickstart/tracks.md) · [composition](docs/zh/quickstart/composition.md) · [styles](docs/zh/quickstart/styles.md) · [images](docs/zh/quickstart/images.md) | 语言细节 |

制作中的判断，让 Agent 自己去读 Skill `references/`，不必人先通读。

### 路径 C — 要改 Hypit 本身（开发者）

| 顺序 | 文档 | 你将得到 |
| --- | --- | --- |
| 1 | [docs/zh/guide/develop.md](docs/zh/guide/develop.md) | 前置条件、`pnpm check` / `pnpm test`、仓库结构 |
| 2 | [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) | PR 范围、CI、发行流程 |
| 3 | [docs/zh/guide/conventions.md](docs/zh/guide/conventions.md) | 命名、模块边界、wire 数据 |
| 4 | [docs/zh/guide/packages.md](docs/zh/guide/packages.md) | 组件 / Model / Provider 职责 |
| 5 | [docs/zh/guide/runtime.md](docs/zh/guide/runtime.md) | Profile、Worker、Result 生命周期 |
| 6 | [docs/zh/guide/component-anatomy.md](docs/zh/guide/component-anatomy.md) + [author-packages.md](docs/zh/guide/author-packages.md) | 写组件 |
| 7 | [docs/zh/guide/providers.md](docs/zh/guide/providers.md) | 写 Model / Provider |
| 8 | [docs/zh/guide/testing.md](docs/zh/guide/testing.md) | 测试怎么跑、哪些要环境开关 |
| 9 | 精确类型：对应 `packages/<name>/README.md` | SDK 真相在包内，不在 Quickstart |

本地开发：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

硬性要求只有 Node 与 pnpm。真实 Build 才需要 Python 3.10–3.13、uv、ffmpeg、由 HyperFrames 管理的 Chromium。

建议切入顺序：`packages/core`（图，不含视频）→ `packages/cli` + `packages/video-cli` → `packages/script` / `packages/timeline` / `packages/film` → 一个组件（如 `packages/ranking`）→ 一个 Provider。

### 路径 D — 要写自己的组件或接新模型

1. [docs/zh/guide/packages.md](docs/zh/guide/packages.md)
2. [docs/zh/guide/author-packages.md](docs/zh/guide/author-packages.md) — 从 `examples/minimal-author-package` 复制
3. [docs/zh/guide/component-anatomy.md](docs/zh/guide/component-anatomy.md)
4. 对照实现：[packages/ranking](packages/ranking/README.md)（语义事件 + Studio Companion）
5. 接模型：[docs/zh/guide/providers.md](docs/zh/guide/providers.md) + [examples/provider-package](examples/provider-package/README.md)
6. Skill：[component-design](skills/hypit/references/production/component-design.md)、[track-authoring](skills/hypit/references/production/track-authoring.md)、[component-visuals](skills/hypit/references/production/component-visuals.md)

### 路径 E — 要理解「语义制作」本身（作者 / Agent 实现者）

从 Skill 生产系统读起，不要从 TypeScript 读起：

1. [skills/hypit/SKILL.md](skills/hypit/SKILL.md) — 职责与问题路由表
2. [references/production/system.md](skills/hypit/references/production/system.md) — 材料、Timeline、组件、Film 如何咬合
3. [references/creation/script-and-time.md](skills/hypit/references/creation/script-and-time.md)
4. [references/production/authoring.md](skills/hypit/references/production/authoring.md) + [source-syntax.md](skills/hypit/references/production/source-syntax.md)
5. [references/production/timeline.md](skills/hypit/references/production/timeline.md) + [tracks.md](skills/hypit/references/production/tracks.md)
6. [references/production/runs.md](skills/hypit/references/production/runs.md) + [builds.md](skills/hypit/references/production/builds.md)
7. 体裁：[playbooks/index.md](skills/hypit/references/playbooks/index.md)

---

## 11. 文档全表（按目录）

### 产品与贡献

| 文件 | 内容 |
| --- | --- |
| [README.zh-CN.md](README.zh-CN.md) / [README.md](README.md) | 产品介绍、示例、安装 |
| [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) | 贡献流程 |
| [LICENSE](LICENSE) | Apache-2.0 + 附加条件（禁止多租户 SaaS、禁止商业再分发；产出物归你） |

### 用户文档 `docs/zh/`

快速开始：`quickstart.md`，以及 `quickstart/` 下的 `script`、`generation`、`timing`、`tracks`、`composition`、`styles`、`images`、`run`、`preview`。

指南：`guide/skill`、`develop`、`packages`、`author-packages`、`component-anatomy`、`providers`、`runtime`、`testing`、`conventions`，以及 Studio 架构页。

英文在 `docs/` 对应路径；改一侧请改另一侧。

### Skill 参考 `skills/hypit/references/`

- **environment/** — `distribution`、`profile`、`model-and-provider`、`local-tools`
- **creation/** — `reference-video`、`brief`、`transformations`、`script-and-time`、`project-files`
- **production/** — `system`、`component-design`、`authoring`、`source-syntax`、`runs`、`builds`、`timeline`、`tracks`、`studio`、`rendering`、`review` 等
- **playbooks/** — formats（ranking、播客、街头采访、口播、短剧、讲解演示）+ craft（画面/声音/字幕/合成/连续性……）

### 包级 README

每个 `packages/<name>/README.md` 是该包的接口真相。Quickstart 讲用法；类型、activation、限制以包 README 和源码为准。

---

## 12. 许可证与费用

- 工具本身：见 [LICENSE](LICENSE)。自用、给客户做片子、单租户部署可以。把 Hypit 当成多租户托管服务卖，或把 Hypit 本身作为产品收费再分发，需要商业许可。
- **你做出来的视频归你。** 第三方模型另有条款。
- Hypit 不收席位费或按条渲染费。钱花在你选择的模型/转写 Provider 上；纯代码渲染可以是 $0。付费前用 `hypit pricing` 看费率，并在 Brief 里记下授权范围。

---

## 13. 建议的「搞懂了」检查清单

能用自己的话回答这些，就算建立了可用模型：

- [ ] Skill、Distribution、视频项目为什么必须分开？
- [ ] `.svml` / `.svs` / `.svrun` 各写什么，谁决定「这次渲什么」？
- [ ] 为什么字幕跟的是词，而不是 `00:03.200`？
- [ ] Model 和 Provider 的差别？换 Key 改哪里，换 API 改哪里？
- [ ] 为什么没有「自动用上次的主播视频」，必须写 `satisfy`？
- [ ] `plan`、`build`、`runtime up`、`studio` 各自会不会花钱、会不会改源码？
- [ ] 新视觉行为应该写进项目 `packages/`，还是改官方 Distribution？

然后选一条路径真做一次：跑 `examples/ranking-football` 的 `check` / `plan`，或从 `minimal-author-package` 复制一个组件。文档是地图；片子是领土。
