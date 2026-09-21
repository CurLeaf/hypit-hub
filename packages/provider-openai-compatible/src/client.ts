import type { CredentialRef } from "@hypit/endpoint-kit";

export type OpenAiCompatibleUploadMode = "openai-json" | "minimax-multipart";

export type OpenAiCompatibleRoutes = {
  readonly image: string;
  readonly imageEdits: string;
  readonly speech: string;
  readonly fileUpload: string;
  readonly videoSubmit: string;
  readonly videoStatus: string;
};

export const defaultOpenAiCompatibleRoutes: OpenAiCompatibleRoutes = {
  image: "/images/generations",
  imageEdits: "/images/edits",
  speech: "/audio/speech",
  fileUpload: "/files",
  videoSubmit: "/videos",
  videoStatus: "/videos/{id}",
};

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("OpenAI-compatible baseUrl must use HTTPS or loopback HTTP");
  }
  return url.href.replace(/\/+$/u, "");
}

export function routePath(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^}]+)\}/gu, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`OpenAI-compatible route is missing ${key}`);
    return encodeURIComponent(value);
  });
}

export class OpenAiCompatibleClient {
  readonly baseUrl: string;
  readonly routes: OpenAiCompatibleRoutes;
  readonly uploadMode: OpenAiCompatibleUploadMode;
  readonly requestTimeoutMs: number;
  readonly fetcher: typeof globalThis.fetch;

  constructor(options: {
    readonly baseUrl: string;
    readonly routes?: Partial<OpenAiCompatibleRoutes>;
    readonly uploadMode?: OpenAiCompatibleUploadMode;
    readonly requestTimeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.routes = { ...defaultOpenAiCompatibleRoutes, ...options.routes };
    this.uploadMode = options.uploadMode ?? "openai-json";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  secret(credentials: Readonly<Record<string, { readonly secret: string }>>): string {
    const value = credentials.apiKey?.secret?.trim();
    if (value === undefined || value.length === 0) throw new Error("OpenAI-compatible API key is missing");
    return value;
  }

  async json(path: string, secret: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.url(path), {
      ...init,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI-compatible ${path} returned HTTP ${response.status}${text.length === 0 ? "" : `: ${text.slice(0, 500)}`}`);
    }
    if (text.length === 0) return {};
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`OpenAI-compatible ${path} returned a non-object response`);
    }
    return parsed as Record<string, unknown>;
  }

  async download(url: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!response.ok) throw new Error(`OpenAI-compatible download returned HTTP ${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType };
  }
}

export type OpenAiCompatibleProviderOptions = {
  readonly instance: string;
  readonly pool: string;
  readonly baseUrl: string;
  readonly apiKey: CredentialRef;
  readonly models: Readonly<Record<string, string>>;
  readonly routes?: Partial<OpenAiCompatibleRoutes>;
  readonly uploadMode?: OpenAiCompatibleUploadMode;
  readonly videoAdapter?: "openai-videos" | "async-tasks" | "minimax-v2";
  readonly defaultConcurrency?: number;
  readonly pollIntervalMs?: number;
  readonly operationTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

export function capabilityKey(capability: { module: { name: string; version: string }; name: string }): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}
