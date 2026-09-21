# 复刻工程

格式：**ugc**（官方布局：`authors/` + `runs/`）

参考片：1789976474163-_2026-09-20_212013_870.mp4
画幅：1280×960，时长 21s
语言：zh

## 结构
- 0s–2.667s：用了两个月天天吹才敢分享的高速护发吹风机…
- 2.667s–4.333s：机搭载HCR合金聚热环恒温出风…
- 4.333s–7s：风均匀不忽高忽低吹完不炸毛…
- 7s–10.167s：毛合金聚热环结构气流加温更均匀…
- 10.167s–11.833s：匀高速电机快干又护发很省心…
- 11.833s–15.167s：心强韧发根防脱三百多性价比拉满…
- 15.167s–17.5s：满但吹完顺滑又有型姐妹们别犹豫…
- 17.5s–20.667s：豫还能当造型风嘴日常冲冲冲…


## 参考图与改编
- 用户参考图已写入 `assets/product-reference.*`。
- 口播文案：按爆款结构改写（对话模型），非参考片原文。
- 配音：导演审查用 TTS 试听；成片 A-roll 口播由 H3 生成（TTS/Fish 仅提供音色样本）。
- A-roll：h3-ugc-replica-v1 + H3 按口播估时生成（4–15s/镜，尾帧衔接），时间轴与字幕对齐 H3 口型音轨。

## 命令
hypit plan runs/final.svrun
hypit pricing runs/final.svrun
hypit build runs/final.svrun --follow
hypit studio --run runs/final.svrun