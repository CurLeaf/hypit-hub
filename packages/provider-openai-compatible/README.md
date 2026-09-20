# `@hypit/provider-openai-compatible`

Runtime Provider for OpenAI-compatible gateways (OpenAI, One API, New API, LiteLLM, and similar
proxies). Configure one `baseUrl`, one API key, and explicit capability-to-model mappings in the
Runtime Profile.

## Supported capabilities

| Hypit capability | Default route | Lifecycle |
| --- | --- | --- |
| `@hypit/gpt-image@1#gpt-image-2` | `POST /images/generations` | immediate |
| `@hypit/seedance@1#seedance-2*` | `POST /videos` + poll | asynchronous |

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
    }
  },
  "bindings": {
    "@hypit/gpt-image@1#gpt-image-2": "gateway.default"
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

Image generation supports text-to-image for common `1K` and some `2K` aspect ratios.
When a request includes reference images, the Provider uploads them through `POST /files`
and submits `POST /images/edits` with `reference_images` URLs (override with `routes.imageEdits`).
