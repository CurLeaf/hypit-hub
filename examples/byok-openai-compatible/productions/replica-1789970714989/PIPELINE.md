# 官方复刻路径检查

状态：**已通过**

- [x] **参考图写入工程** — 应含 assets/product-reference 与 gpt/H3 Reference 绑定
- [x] **TTS 改编配音** — 官方路径使用 TTS 音色样本（voice-reference / presenter-voice / fish:VoiceDesign），而非 reference-audio（参考片原声）
- [x] **H3 A-roll 口播** — 启用 H3 口播时应含 h3:ReferenceVideo + speaker-v1 prompt
- [x] **speaker-v1 模板** — H3 prompt 由官方 speaker-v1 模板渲染
- [x] **B-roll 参考图 edits** — 分镜图应通过 gpt:Reference 传入产品参考图
- [x] **未使用参考片原声** — 官方路径不应以 reference-audio 作为口播轨
