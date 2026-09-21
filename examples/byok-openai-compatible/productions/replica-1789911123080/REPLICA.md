# 复刻工程

格式：**ugc**（官方布局：`authors/` + `runs/`）

参考片：1789910586544-_2026-09-20_212013_870.mp4
画幅：1280×960，时长 21s
语言：zh

## 结构
- 0.051s–20.17s：用了三個月吹了幾十次才敢分享的吹風機，風速一開頭髮直接立起來，兩億負離子吹完頭髮…


## 参考图与改编
- 用户参考图已写入 `assets/product-reference.*`。
- 口播文案：按爆款结构改写（对话模型），非参考片原文。
- 配音：Fish VoiceDesign（若 Runtime 已绑定）或 TTS 音色样本（BYOK 兜底）。
- A-roll：官方 speaker-v1 + 多 Segment h3:ReferenceVideo Take（共 1 段）。

## 命令
hypit plan runs/final.svrun
hypit pricing runs/final.svrun
hypit build runs/final.svrun --follow
hypit studio --run runs/final.svrun