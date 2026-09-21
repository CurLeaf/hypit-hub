# 官方复刻路径检查

状态：**已通过**

- [x] **参考图写入工程** — 应含 assets/product-reference 与 gpt/H3 Reference 绑定
- [x] **音色样本已写入工程** — TTS/Fish 仅作 H3 音色参考（presenter-voice / voice-reference）；成片口播由 H3 音轨驱动，不用 reference-audio
- [x] **H3 A-roll 口播** — 启用 H3 口播时应含 h3:ReferenceVideo + h3-ugc-replica-v1 prompt
- [x] **H3 prompt 模板** — H3 prompt 应由 @hypit/minimax-h3-kits 模板渲染
- [x] **B-roll 参考图 edits** — 分镜图应通过 gpt:Reference 传入产品参考图
- [x] **未使用参考片原声** — 官方路径不应以 reference-audio 作为口播轨
