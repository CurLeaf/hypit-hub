# `@hypit/provider-openai-compatible`

Runtime Provider for OpenAI-compatible gateways (OpenAI, One API, New API, LiteLLM, and similar
proxies). Configure one `baseUrl`, one API key, and explicit capability-to-model mappings in the
Runtime Profile.

## Supported capabilities

| Hypit capability | Default route | Lifecycle |
| --- | --- | --- |
| `@hypit/gpt-image@1#gpt-image-2` | `POST /images/generations` | immediate |
| `@hypit/seedance@1#seedance-2*` | `POST /videos` + poll | asynchronous |
| `@hypit/minimax-h3@1#minimax-h3` | `POST /videos` + poll | asynchronous |

An Endpoint offers exactly the capabilities its `models` map names, and nothing else, so two gateways
in one Profile no longer both look like they serve this whole catalog. Add a mapping to compare video
models (for example `seedance-2-mini` beside `minimax-h3`) and that model becomes available to Runs;
mapping a capability this Provider does not implement stops activation with a message naming it.

WhisperX alignment, media processing and HyperFrames rendering remain local Providers configured
separately in the same Profile.

## Profile example

```json
{
  "endpoints": {
    "gateway.default": {
      "use": "@hypit/provider-openai-compatible",
      "config": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": { "store": "env", "key": "OPENAI_API_KEY" },
        "models": {
          "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2",
          "@hypit/seedance@1#seedance-2-mini": "seedance-2-mini"
        },
        "videoAdapter": "openai-videos"
      }
    },
    "gateway.minimax": {
      "use": "@hypit/provider-openai-compatible",
      "config": {
        "baseUrl": "https://api.minimax.chat/v1",
        "apiKey": { "store": "env", "key": "H3_VIDEO_API_KEY" },
        "referenceUpload": "s3",
        "models": {
          "@hypit/minimax-h3@1#minimax-h3": "MiniMax-H3"
        }
      }
    }
  },
  "bindings": {
    "@hypit/gpt-image@1#gpt-image-2": "gateway.default",
    "@hypit/minimax-h3@1#minimax-h3": "gateway.minimax"
  }
}
```

## Configuration

| Field | Meaning |
| --- | --- |
| `baseUrl` | Gateway root, usually ending in `/v1` |
| `apiKey` | Credential Store reference |
| `models` | Full capability name → remote model id |
| `routes` | Optional path overrides for `image`, `imageEdits`, `speech`, `videoSubmit`, `videoStatus` |
| `videoAdapter` | `openai-videos` (default) or `async-tasks` for `/tasks/{id}` polling |
| `defaultConcurrency` | Shared request capacity |
| `pollIntervalMs` | Async video poll interval |
| `operationTimeoutMs` | Async video timeout |
| `chatModel`, `ttsModel`, `ttsVoice` | Optional. Read by the authoring workflow (Analysis chat, script rewrite and TTS), not by this Provider's requests |
| `referenceUpload` | `gateway` (default): `POST /files` on this Endpoint. `s3`: presigned POST to the OSS/S3 bucket in `S3_*` env, then pass the `S3_CDN` URL to the model |

Image generation supports text-to-image for common `1K` and some `2K` aspect ratios.
When a request includes reference images, the Provider uploads them through `POST /files`
and submits `POST /images/edits` with `reference_images` URLs (override with `routes.imageEdits`).
Set `referenceUpload` to `s3` when the gateway has no usable `/files` route (MiniMax H3 is the usual case).
That path uses the same env names as an Aliyun OSS public-read upload (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_REGION`, `S3_CDN`). The model then fetches
`{S3_CDN}/hypit/references/...` instead of a gateway file URL.
