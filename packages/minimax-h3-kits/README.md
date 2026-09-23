# `@hypit/minimax-h3-kits`

Data-only authoring Kits aligned with the [MiniMax H3 Video Generation V2 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create). They are `TextTemplate` source modules, not model wrappers or Providers.

These Kits target **reference-to-video (r2va)**: a required `text` prompt plus `reference_image` / `reference_video` / `reference_audio` items in the `content` array. Hypit maps them to `h3:ReferenceVideo` graph edges and `POST /v2/video_generation`.

```svml
<import as="text" from="@hypit/text@1"/>
<import as="h3" from="@hypit/minimax-h3@1"/>
<import as="h3-kit" source="@hypit/minimax-h3-kits/ugc-replica"/>

<text:Render id="shot-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}>
  <text:Set name="dialogue" text={story.segment.shot_1.dialogue}/>
  <text:Set name="action" text={shot-action}/>
</text:Render>

<h3:ReferenceVideo id="shot-take" prompt={shot-prompt} duration="15"
  resolution="768P" aspect-ratio="9:16">
  <h3:Reference image={product-reference}/>
  <h3:Reference audio={voice-reference}/>
</h3:ReferenceVideo>
```

## Choose a template

| Import suffix / template | r2va inputs | Text slots |
| --- | --- | --- |
| `ugc-replica` / [`h3-ugc-replica-v1`](kits/h3-ugc-replica-v1.svs) | `reference_image`(s) + `reference_audio` | Required `dialogue`; optional `action`, optional `tier-list` |
| `speaker` / [`h3-speaker-v1`](kits/h3-speaker-v1.svs) | `reference_image` + `reference_audio` | Required `dialogue`; optional `action` |

Official r2va prompt style (from MiniMax docs):

```text
Character speaks: Follow the wind, live free. Leave worries behind, enjoy the moment. Voice timbre follows reference audio 1.
```

`h3-speaker-v1` renders dialogue under `Character speaks:` and repeats `Voice timbre follows reference audio 1.` in the contract block. `h3-ugc-replica-v1` uses `Spoken script:` for narration-first UGC where a visible person is optional.

## API constraints reflected in the Kits

| API field / rule | Kit / pipeline assumption |
| --- | --- |
| `model`: `MiniMax-H3` | Bound in Runtime Profile |
| `content[].type=text` required, ≤ 7000 chars | Rendered `text:Render` output |
| r2va roles: `reference_image`, `reference_audio`, `reference_video` | `h3:Reference` edges; BYOK replica uses image + audio |
| `reference_audio` duration 2–15 s per clip | `voice-reference.wav` clipped from TTS (default 6 s) |
| `duration` 4–15 for `MiniMax-H3` | `shot-plan` splits long references into 15 s takes |
| `ratio` optional for r2va (default `adaptive`) | Replica scaffold often sets `9:16` explicitly |
| `resolution` `768P` or `2K` | Replica scaffold defaults to `768P` |
| r2va mutually exclusive with `first_frame` / `last_frame` | Use `h3:FrameVideo` for i2v, not these Kits |

Reference audio supplies **timbre only**. The prompt must carry the script to perform; the model generates fresh speech in that timbre rather than replaying the uploaded sample.

`h3-ugc-replica-v1` also instructs H3 to **burn subtitles into the picture** (bottom-center, phrase-synced to the spoken script). The UGC replica scaffold does not add a `caption-fine` overlay track for H3 A-roll. When analysis detects ranking/tier-list content, the scaffold may also supply the optional `tier-list` slot with a left-side panel spec; other UI overlays remain prompt-driven rather than globally forced.

## Not covered here

- **Text-to-video** and **image-to-video (first / last frame)** use direct prompts or separate authoring flows, not these r2va Kits.
- **Seedance** prompt Kits remain in `@hypit/seedance-kits`.
