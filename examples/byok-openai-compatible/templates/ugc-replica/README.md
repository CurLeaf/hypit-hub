# UGC 复刻模板

## 与官方 Skill 的关系

| 官方 UGC playbook（HypiHub / Seedance） | 本 BYOK Analysis 快捷道 |
|----------------------------------------|-------------------------|
| 深读 `references/*/ANALYSIS.md` + `TIMELINE.md` | 自动转写 + 深读归档 + UI 解读 |
| 用户审阅 `BRIEF.md` / `TREATMENT.md` | Cursor Agent 导演审查（`.hypit/analysis/director/`）后制作配音 |
| `phone-ugc-v1` 人物图 + `fish:VoiceDesign` | 用户参考图 + OpenAI `tts-1`（BYOK 兜底） |
| `seedance` + `speaker-v1` 多 Take | `@hypit/minimax-h3-kits` + `shot_N` 时间轴，镜间用尾帧衔接 |
| `hypit measure` 估时长 | `@hypit/estimate` 按镜估秒（4–15s） |
| `fish:VoiceDesign` | Runtime 绑定了 Fish 时用它；否则用 TTS 音色样本 |
| Plan/Pricing 确认后 Build | Analysis「生成」页先出 plan/pricing，再点生成视频 |

官方竖屏口播复刻的最小工程模板。Analysis 一键复刻会：

1. 分析参考视频（Hook、切镜、口播结构）
2. 提取参考片音频并对齐字幕
3. 若用户上传了**参考图**，默认用 **MiniMax H3** 生成 A-roll 口播视频
4. B-roll 分镜使用 `gpt:Image` + 参考图

## 用户参考图 + 改编口播 + MiniMax H3

上传参考图后，Analysis 会按官方「忠实改编」原则：

1. **结构**：从参考片继承 Hook、切镜、段落节奏（为什么火）
2. **文案**：对话模型（`HYPIT_CHAT_MODEL`）按 Brief/改编说明改写各段口播
3. **配音**：`tts-1`（`HYPIT_TTS_MODEL`）供导演审查试听；H3 音色样本取自 TTS 前 6 秒；**成片口播由 H3 按改写文案生成**
4. **画面**：参考图 → `h3:ReferenceVideo` + `gpt:Image` Reference

在侧栏填写「改编说明」（产品名、卖点）并勾选 **MiniMax H3 口播**（默认开启）后，生成的 SVML 会包含：

```xml
<import as="h3-kit" source="@hypit/minimax-h3-kits/ugc-replica"/>
<asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
<asset:Audio id="presenter-voice" src="../assets/voice-reference.wav"/>
<text:Render id="shot_1-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}>
  <text:Set name="dialogue" text={story.segment.shot_1.dialogue}/>
  <text:Set name="action" text={shot_1-action}/>
</text:Render>
<h3:ReferenceVideo id="shot_1-take" prompt={shot_1-prompt}
  duration="15" resolution="768P" aspect-ratio="9:16">
  <h3:Reference image={product-reference}/>
  <h3:Reference audio={presenter-voice}/>
</h3:ReferenceVideo>
```

需要配置 `H3_VIDEO_API_KEY` 与 `gateway.minimax`（见 `hypit.runtime.json`）。

B-roll 分镜仍使用 `gpt:Image` + `<gpt:Reference>`（`OPENAI_API_KEY` / `gateway.default`）。

`voice-reference.wav` 由 **TTS 合成音频前 6 秒**截取，作为 H3 音色参考（不是参考片原声，也不是成片口播轨）。成片时间轴与字幕对齐 **H3 生成的口型音轨**；每镜时长按口播估时（4–15s）。

## 命令

```bash
hypit plan runs/final.svrun
hypit build runs/final.svrun --follow
```
