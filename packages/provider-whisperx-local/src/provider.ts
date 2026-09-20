import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealAlignedTranscriptEvidence, speechEvidenceTypes } from "@hypit/speech-evidence";
import type { AlignedTranscriptEvidence } from "@hypit/speech-evidence";
import type { EndpointInvocationContext, EndpointFulfillment } from "@hypit/endpoint-kit";
import { canonicalize } from "@hypit/protocol";
import type { CanonicalValue } from "@hypit/protocol";
import { defineEndpointPackage } from "@hypit/endpoint-kit";
import {
  assertWhisperXEvidenceWav,
  interpretWhisperXTranscript,
  verifyWhisperXAlignmentRequest,
  whisperXCapabilities,
} from "@hypit/whisperx";
import type { WhisperXTranscriptResponse } from "@hypit/whisperx";

export const localWhisperXProviderModuleRef = {
  name: "@hypit/provider-whisperx-local",
  version: "1",
} as const;
export const localWhisperXDefaults = {
  baseUrl: "http://127.0.0.1:8765",
  expectedModel: "small",
  expectedDevice: "cpu",
  expectedBatchSize: 8,
  expectedServiceVersion: "0.1.0",
  expectedWhisperXVersion: "3.8.6",
  requestTimeoutMs: 20 * 60_000,
} as const;
export type CreateLocalWhisperXProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  /** Must resolve to the same machine because the protocol passes a staged local path. */
  readonly baseUrl?: string;
  readonly expectedModel?: string;
  readonly expectedDevice?: string;
  readonly expectedCompute?: string;
  readonly expectedBatchSize?: number;
  readonly expectedServiceVersion?: string;
  readonly expectedWhisperXVersion?: string;
  readonly defaultConcurrency?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
};

export type WhisperXServiceResponse = WhisperXTranscriptResponse;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function positiveInteger(value: number, subject: string): number {
  assert(Number.isSafeInteger(value) && value > 0, `${subject} must be a positive integer`);
  return value;
}

export const interpretWhisperXResponse = interpretWhisperXTranscript;

function result(value: CanonicalValue): EndpointFulfillment {
  return { value: { kind: "inline", value } };
}

type HttpJsonResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly value: unknown;
};

/** Loopback HTTP without fetch's fixed headers timeout; CPU transcription can exceed five minutes. */
async function httpJson(
  urlString: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly subject: string;
  },
): Promise<HttpJsonResponse> {
  const url = new URL(urlString);
  assert(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    "local WhisperX HTTP client requires a loopback URL");
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: HttpJsonResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(response!);
      else reject(error);
    };
    const onAbort = (): void => {
      req.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("WhisperX request aborted"));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const headers = { ...options.headers };
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port.length > 0 ? Number(url.port) : 80,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers,
    }, (res) => {
      res.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > options.maxBytes) {
          req.destroy(new Error(`${options.subject} exceeded the configured response limit`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        options.signal?.removeEventListener("abort", onAbort);
        const bytes = Buffer.concat(chunks);
        const status = res.statusCode ?? 500;
        const ok = status >= 200 && status < 300;
        if (!ok) {
          finish(new Error(`${options.subject} failed with HTTP ${status}: ${bytes.toString("utf8").slice(0, 500)}`));
          return;
        }
        try {
          finish(undefined, { ok, status, value: JSON.parse(bytes.toString("utf8")) });
        } catch {
          finish(new Error(`${options.subject} returned invalid JSON`));
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`${options.subject} timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    req.on("error", (error) => finish(error));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export function createLocalWhisperXProvider(config: CreateLocalWhisperXProviderOptions) {
  const baseUrl = new URL(config.baseUrl ?? localWhisperXDefaults.baseUrl);
  assert(baseUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(baseUrl.hostname),
    "local WhisperX Provider requires a loopback HTTP service");
  const normalizedBaseUrl = baseUrl.href.replace(/\/+$/u, "");
  const expectedModel = config.expectedModel ?? localWhisperXDefaults.expectedModel;
  const expectedDevice = config.expectedDevice ?? localWhisperXDefaults.expectedDevice;
  const expectedCompute = config.expectedCompute ?? (expectedDevice === "cpu" ? "int8" : "float16");
  const expectedBatchSize = positiveInteger(config.expectedBatchSize ?? localWhisperXDefaults.expectedBatchSize, "expectedBatchSize");
  const expectedServiceVersion = config.expectedServiceVersion ?? localWhisperXDefaults.expectedServiceVersion;
  const expectedWhisperXVersion = config.expectedWhisperXVersion ?? localWhisperXDefaults.expectedWhisperXVersion;
  assert(expectedModel.trim().length > 0, "expectedModel is empty");
  assert(expectedDevice.trim().length > 0, "expectedDevice is empty");
  assert(expectedCompute.trim().length > 0, "expectedCompute is empty");
  assert(expectedServiceVersion.trim().length > 0, "expectedServiceVersion is empty");
  assert(expectedWhisperXVersion.trim().length > 0, "expectedWhisperXVersion is empty");
  const requestTimeoutMs = positiveInteger(config.requestTimeoutMs ?? localWhisperXDefaults.requestTimeoutMs, "requestTimeoutMs");
  const maxResponseBytes = positiveInteger(config.maxResponseBytes ?? 64 * 1024 * 1024, "maxResponseBytes");

  return defineEndpointPackage({
    module: localWhisperXProviderModuleRef,
    facet: "alignment",
    instance: config.instance ?? "whisperx.local",
    pool: config.pool ?? config.instance ?? "whisperx.local",
    pricing: { kind: "local" },
    defaultConcurrency: config.defaultConcurrency ?? 1,
    capabilities: [{
      lifecycle: "immediate" as const,
      capability: whisperXCapabilities.alignment,
      returns: speechEvidenceTypes.alignedTranscript,
      handler: async (context: EndpointInvocationContext) => {
        const request = verifyWhisperXAlignmentRequest(context.need.constraints);
        const audio = await context.resources.get(request.audio.resource);
        assert(audio !== undefined && audio.byteLength === request.audio.size,
          `WhisperX evidence Artifact ${request.audio.resource} is unavailable or has changed`);
        assertWhisperXEvidenceWav(audio, request.sampleFrames);
        const work = await mkdtemp(join(tmpdir(), "hypit-whisperx-local-"));
        try {
          const audioPath = join(work, "alignment-evidence.wav");
          await writeFile(audioPath, audio);
          const signal = AbortSignal.timeout(requestTimeoutMs);
          await context.reportProgress?.({ phase: "Checking local transcription service" });
          const health = await httpJson(`${normalizedBaseUrl}/health`, {
            signal,
            timeoutMs: Math.min(requestTimeoutMs, 60_000),
            maxBytes: Math.min(maxResponseBytes, 64 * 1024),
            subject: "WhisperX health",
          });
          assert(health.value !== null && typeof health.value === "object" && !Array.isArray(health.value),
            "WhisperX health response is invalid");
          const healthValue = health.value as {
            readonly ok?: unknown;
            readonly protocol?: unknown;
            readonly serviceVersion?: unknown;
            readonly whisperxVersion?: unknown;
            readonly model?: unknown;
            readonly device?: unknown;
            readonly compute?: unknown;
            readonly batchSize?: unknown;
          };
          assert(healthValue.ok === true
            && healthValue.protocol === "hypit.whisperx-service@1"
            && healthValue.serviceVersion === expectedServiceVersion
            && healthValue.whisperxVersion === expectedWhisperXVersion
            && healthValue.model === expectedModel
            && healthValue.device === expectedDevice
            && healthValue.compute === expectedCompute
            && healthValue.batchSize === expectedBatchSize,
          "WhisperX service runtime identity differs from the configured Provider");
          await context.reportProgress?.({ phase: "Transcribing and aligning words" });
          const raw = await httpJson(`${normalizedBaseUrl}/transcribe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              audio_path: audioPath,
              language: request.language,
            }),
            signal,
            timeoutMs: requestTimeoutMs,
            maxBytes: maxResponseBytes,
            subject: "WhisperX transcription",
          });
          assert(raw.value !== null && typeof raw.value === "object" && !Array.isArray(raw.value),
            "WhisperX transcription response is invalid");
          const response = raw.value as WhisperXServiceResponse;
          const passages = interpretWhisperXResponse(response, request.sampleFrames);
          const evidence: AlignedTranscriptEvidence = sealAlignedTranscriptEvidence({
            passages,
          });
          await context.reportProgress?.({ phase: "Word timing ready" });
          return result(canonicalize(evidence));
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      },
    }],
  });
}
