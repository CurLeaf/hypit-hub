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
| `minimax-video.svrun` | `minimax-h3` via `gateway.minimax` | Six-second AI video via `H3_VIDEO_API_KEY` |

MiniMax video example:

```bash
node bin/hypit.mjs plan examples/byok-openai-compatible/minimax-video.svrun --workspace examples/byok-openai-compatible
node bin/hypit.mjs build examples/byok-openai-compatible/minimax-video.svrun --workspace examples/byok-openai-compatible --follow
```

## Replica workflow (reference video + product image)

The Analysis UI (`hypit analysis`) supports the official adaptation path:

1. Click **使用默认视频** (CDN `origin.mp4` after `pnpm upload:origin`) or upload a **reference video** → analyze why it works (ANALYSIS / TIMELINE)
2. Upload a **reference image** (product or presenter) in the sidebar
3. Fill **改编说明** with your product name, selling points, and audience
4. Enable **MiniMax H3 口播** (default when a reference image is present)
5. Click **一键复刻** → generates `productions/replica-*/` with:
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
- **Image + reference** uploads media to `POST <baseUrl>/files`, then uses `POST /images/edits` with
  `reference_images`.
- **MiniMax H3 ReferenceVideo** publishes the reference image and voice sample to the public OSS
  bucket in `S3_*` (`referenceUpload: "s3"`), then `POST /videos` with those `S3_CDN` URLs.
- **Other videos** use `POST /videos` and poll `GET /videos/{id}` by default.
- If your gateway exposes async jobs at `/tasks/{id}`, set `videoAdapter` to `async-tasks` and
  adjust `routes.videoStatus` accordingly.
- Unsupported capabilities are reported by `plan` before any paid call is submitted.

## Known limits

- `gpt-image-2` reference edits still use `POST <baseUrl>/files` on `gateway.default`.
- H3 ReferenceVideo does **not** use MiniMax `/files`. Set `referenceUpload` to `s3` and the same
  `S3_*` env names as erp-admin-demo-1; MiniMax fetches `{S3_CDN}/hypit/references/…`.
- H3 is bound as `@hypit/minimax-h3@1#minimax-h3` → `MiniMax-H3` on `gateway.minimax` (`H3_VIDEO_API_KEY`).
- H3 clips are capped at 15 seconds per request; longer references are clamped in the replica scaffold.
- Speech/TTS capabilities are not wired in this example Profile.
- Video payload shape follows OpenAI-style `videos` routes; custom gateways may need route or
  adapter adjustments in `@hypit/provider-openai-compatible`.

## Comparing video models

Each Endpoint offers only the capabilities listed in its own `models` map, so adding a second video
model is a Profile edit rather than a code change. For example, to render the same treatment with
Seedance beside MiniMax H3, add a mapping to the gateway that serves it:

```json
"models": {
  "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2",
  "@hypit/seedance@1#seedance-2-mini": "seedance-2-mini"
}
```

Author a Run per model and compare the two Results; `plan` names the Endpoint and remote model each
request will use before anything is submitted. Two Endpoints mapping the same capability is the one
case that needs a `bindings` entry saying which one runs it.
