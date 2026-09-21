# BYOK OpenAI-compatible example

This example runs without HypiHub. Local media processing, HyperFrames rendering and WhisperX stay on
the machine. Image and video generation route through your own OpenAI-compatible gateway.

## Prerequisites

- Node.js 22.15+
- `ffmpeg`, `ffprobe`, `uv` and Chrome for local Runtime services
- An OpenAI-compatible gateway account and API key

## Setup

1. Copy the environment template and set your key:

```bash
cp .env.example .env
```

2. Edit `hypit.runtime.json`:

- Set `gateway.default.config.baseUrl` to your gateway, for example `https://api.openai.com/v1`
- Map each capability in `models` to the model name your gateway expects

3. Load keys for the Runtime Worker (PowerShell):

```powershell
. ./load-env.ps1
```

- `OPENAI_API_KEY` → `gateway.default` (images)
- `H3_VIDEO_API_KEY` → `gateway.minimax` (MiniMax H3 video)
- When `gateway.minimax.referenceUpload` is `s3`, also set `S3_*` and `S3_CDN` in `.env` (see `.env.example`)

## Verify

From the repository root after `pnpm install`:

```bash
node bin/hypit.mjs runtime use ./examples/byok-openai-compatible/hypit.runtime.json --workspace examples/byok-openai-compatible
node bin/hypit.mjs runtime up --workspace examples/byok-openai-compatible
node bin/hypit.mjs doctor --workspace examples/byok-openai-compatible
node bin/hypit.mjs plan examples/byok-openai-compatible/minimal.svrun --workspace examples/byok-openai-compatible
node bin/hypit.mjs build examples/byok-openai-compatible/minimal.svrun --workspace examples/byok-openai-compatible --follow
```

| Run | Model | What it does |
| --- | --- | --- |
| `minimal.svrun` | `gpt-image-2` via `gateway.default` | One still image + five-second local render |
| `reference-image.svrun` | `gpt-image-2` via `gateway.default` | Product reference image + prompt → image edit → five-second render |
| `reference-video.svrun` | `MiniMax-H3` via `gateway.minimax` | Reference image + voice sample → H3 talking-head video |

H3 video generation requires a **reference image and reference audio**; prompt-only text-to-video is not supported in this example.

## Replica workflow (reference video + product image)

The Analysis UI (`hypit analysis`) supports the official adaptation path:

1. Upload a **reference video** → analyze why it works (ANALYSIS / TIMELINE)
2. Upload a **reference image** (product or presenter) in the sidebar
3. Fill **改编说明** with your product name, selling points, and audience
4. **Director review (Cursor Agent):** edit `.hypit/analysis/director/BRIEF.md`, `TREATMENT.md`, `scenes.json` — see `AGENTS.md`
5. Click **导演审查通过** in Analysis UI → TTS adaptation runs
6. Enable **MiniMax H3 口播** (default when a reference image is present)
7. Click **一键复刻** → generates `productions/replica-*/` with:
   - **Script**: chat model rewrites dialogue (keeps viral structure, new product copy)
   - **Speech**: `tts-1` via `gateway.default` (`HYPIT_TTS_MODEL`)
   - **A-roll**: `h3:ReferenceVideo` (reference image + TTS timbre sample + new dialogue)
   - **B-roll**: `gpt:Image` with `<gpt:Reference image={product-reference.image}/>`

H3 uploads image/audio refs via `POST /files`, then `POST /videos` with `reference_image_urls` and `reference_audios`.
B-roll image requests use `POST /images/edits`.

See `templates/ugc-replica/README.md` for the generated project layout.

Reference-image only (no replica):

```bash
node bin/hypit.mjs plan examples/byok-openai-compatible/reference-image.svrun --workspace examples/byok-openai-compatible
node bin/hypit.mjs build examples/byok-openai-compatible/reference-image.svrun --workspace examples/byok-openai-compatible --follow
```

Replace `assets/product-reference.jpg` with your own product or presenter image.

MiniMax H3 talking-head only:

```bash
node bin/hypit.mjs plan examples/byok-openai-compatible/reference-video.svrun --workspace examples/byok-openai-compatible
node bin/hypit.mjs build examples/byok-openai-compatible/reference-video.svrun --workspace examples/byok-openai-compatible --follow
```

Requires `H3_VIDEO_API_KEY`, `assets/product-reference.jpg`, and `assets/voice-reference.wav` (a short voice timbre sample).

## Gateway notes

- **Text-to-image** uses `POST /images/generations` with `prompt`, `size`, and `model`.
- **Image + reference** uploads media to `POST /files`, then uses `POST /images/edits` with `reference_images`.
- **MiniMax H3 ReferenceVideo** uses `POST /videos` with `reference_image_urls`, `reference_audios`, `prompt`, `seconds`, etc. Both reference image and reference audio are required.
- If your gateway exposes async jobs at `/tasks/{id}`, set `videoAdapter` to `async-tasks` and
  adjust `routes.videoStatus` accordingly.
- Unsupported capabilities are reported by `plan` before any paid call is submitted.

## Known limits

- `gpt-image-2` reference edits and H3 ReferenceVideo both require `POST /files` upload on your gateway.
- H3 is bound as `@hypit/minimax-h3@1#minimax-h3` → `MiniMax-H3` on `gateway.minimax` (`H3_VIDEO_API_KEY`).
- H3 clips are capped at 15 seconds per request; longer references are clamped in the replica scaffold.
- Speech/TTS capabilities are not wired in this example Profile.
- Video payload shape follows OpenAI-style `videos` routes; custom gateways may need route or
  adapter adjustments in `@hypit/provider-openai-compatible`.
