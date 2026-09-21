# 复刻工程

格式：**ugc**（官方布局：`authors/` + `runs/`）

参考片：1789910586544-_2026-09-20_212013_870.mp4
画幅：1280×960，时长 21s
语言：zh

## 结构
- 0s–2.667s：穿了三个月通勤周末都穿才敢分享的叠穿套装…
- 2.667s–4.333s：橄榄绿工装夹克大口袋一眼机能感立起来…
- 4.333s–7s：军绿配色搭白内搭层次不用想…
- 7s–10.167s：内外配好拉开就是完整造型…
- 10.167s–11.833s：松紧收口廓形上身有余量很省心…
- 11.833s–15.167s：三百多的价格性价比直接拉满但上身好看又有型…
- 15.167s–17.5s：兄弟们别犹豫还可以单穿夹克冲冲冲…
- 17.5s–20.667s：…


## 参考图与改编
- 用户参考图已写入 `assets/product-reference.*`。
- 口播文案：按爆款结构改写（对话模型），非参考片原文。
- 配音：Fish VoiceDesign（若 Runtime 已绑定）或 TTS 音色样本（BYOK 兜底）。
- A-roll：官方 speaker-v1 + 多 Segment h3:ReferenceVideo Take（共 7 段）。

## 命令
hypit plan runs/final.svrun
hypit pricing runs/final.svrun
hypit build runs/final.svrun --follow
hypit studio --run runs/final.svrun