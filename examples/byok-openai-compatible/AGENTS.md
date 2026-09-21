# BYOK 复刻项目 — Agent 导演手册

本示例的爆款复刻走 **Analysis 预处理 + Cursor Agent 导演审查 + Hypit Runtime 成片**。

## 工作目录

在仓库根目录或本目录打开 Cursor，工作区指向：

`examples/byok-openai-compatible`

## 标准流程

1. 启动 Analysis：`hypit analysis`（或项目已有 UI）
2. 上传参考视频 → **开始分析**
3. 上传产品/人物参考图，填写改编说明
4. **导演审查（Cursor Agent）**：配置 `CURSOR_API_KEY` 后，Analysis 会自动启动 Agent 改写 `.hypit/analysis/director/`；也可在 UI 点「启动 Cursor Agent」
5. 导演审查通过 → 自动制作 TTS 配音
6. 用户试听配音确认后 → **一键复刻** → Plan/Pricing → Build

## 导演审查目录

| 文件 | 作用 |
|------|------|
| `REVIEW_REQUEST.md` | 任务说明与素材路径 |
| `CHECKLIST.md` | 审查清单 |
| `BRIEF.md` | 用户目标 + 产品事实（无占位符） |
| `TREATMENT.md` | 切点、画面、表演方向 |
| `scenes.json` | 各 `scene-*` 段口播（与切点对齐） |

## 与官网 [hypit.ai](https://hypit.ai/) 的对齐

| 官网能力 | 本项目管理方式 |
|----------|----------------|
| Agent 导演 | Cursor + 本文件 + `.cursor/rules/hypit-director-review.mdc` |
| 全片结构复刻 | `scenes.json` 多段 + TIMELINE 切点 |
| 配音 | 导演稿通过后 TTS；H3 用 6s 音色样本 + speaker-v1 |
| 批量变体 | 多条 `.svrun` / 多个 production（待扩展） |
| HypiHub 音色 | 可选 `hypit.runtime.hypihub.example.json` 启用 Fish Speech |

## 常用命令

```bash
node bin/hypit.mjs runtime up --workspace examples/byok-openai-compatible
node bin/hypit.mjs plan productions/replica-*/runs/final.svrun --workspace examples/byok-openai-compatible
node bin/hypit.mjs build productions/replica-*/runs/final.svrun --workspace examples/byok-openai-compatible --follow
```
