# UGC 复刻模板

## 与官方 Skill 的关系

| 官方 UGC playbook（HypiHub / Seedance） | 本 BYOK Analysis 快捷道 |
|----------------------------------------|-------------------------|
| 深读 `references/*/ANALYSIS.md` + `TIMELINE.md` | 自动转写 + 深读归档 + UI 解读 |
| 用户审阅 `BRIEF.md` / `TREATMENT.md` | 上传参考图后自动生成（`.hypit/analysis/adaptation/`） |
| `phone-ugc-v1` 人物图 + `fish:VoiceDesign` | 用户参考图 + OpenAI `tts-1`（BYOK 兜底） |
| `seedance` + `speaker-v1` 多 Take | `speaker-v1` prompt + 多 Segment `h3:ReferenceVideo` Take |
| `hypit measure` 估时长 | `@hypit/estimate` 按 Segment 估秒（4–15s） |
| `fish:VoiceDesign` | 使用 `hypit.runtime.hypihub.example.json` 绑定 HypiHub 后自动启用；否则 TTS 音色样本（BYOK） |
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
3. **配音**：`tts-1`（`HYPIT_TTS_MODEL`）合成新口播；H3 音色样本取自 TTS 前 6 秒
4. **画面**：参考图 → `h3:ReferenceVideo` + `gpt:Image` Reference

在侧栏填写「改编说明」（产品名、卖点）并勾选 **MiniMax H3 口播**（默认开启）后，生成的 SVML 会包含：

```xml
<asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
<asset:Audio id="voice-reference" src="../assets/voice-reference.wav"/>
<h3:ReferenceVideo id="speaker-take" prompt={speaker-prompt}
  duration="6" resolution="768P" aspect-ratio="9:16">
  <h3:Reference image={product-reference.image}/>
  <h3:Reference audio={voice-reference}/>
</h3:ReferenceVideo>
```

需要配置 `H3_VIDEO_API_KEY` 与 `gateway.minimax`（见 `hypit.runtime.json`）。

B-roll 分镜仍使用 `gpt:Image` + `<gpt:Reference>`（`OPENAI_API_KEY` / `gateway.default`）。

`voice-reference.wav` 由参考片音频前 6 秒自动截取，作为音色参考。

## 命令

```bash
hypit plan runs/final.svrun
hypit build runs/final.svrun --follow
```
