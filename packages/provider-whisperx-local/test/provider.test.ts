import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { sealSpeechEvidenceAudio, speechTypes } from "@hypit/speech";
import assert from "node:assert/strict";
import { MemoryResourceStore, EndpointRegistry } from "@hypit/driver-node";
import type { Need } from "@hypit/protocol";
import { speechEvidenceTypes } from "@hypit/speech-evidence";
import {
  whisperXCapabilities,
  whisperXRequestForEvidenceAudio,
} from "@hypit/whisperx";

import {
  createLocalWhisperXProvider,
  interpretWhisperXResponse,
} from "../src/index.js";

function wav(sampleFrames: number): Uint8Array {
  const bytes = new Uint8Array(44 + sampleFrames * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, sampleFrames * 2, true);
  return bytes;
}

test("local WhisperX Provider pins the complete service runtime and is independently queued", () => {
  const provider = createLocalWhisperXProvider({ expectedModel: "small", defaultConcurrency: 2 });
  assert.equal(provider.instance.id, "whisperx.local");
  assert.throws(
    () => createLocalWhisperXProvider({ baseUrl: "https://whisper.example.com" }),
    /loopback/u,
  );
});

test("wire seconds are lowered once to exact evidence samples without authored Segment knowledge", () => {
  const evidence = interpretWhisperXResponse({
    language: "en",
    segments: [{
      start: 0.1,
      end: 1.8,
      words: [
        { text: "hello", start: 0.1, end: 0.4, score: 0.99 },
        { text: "crossing", start: 0.9, end: 1.1, score: 0.8 },
        { text: "world", start: 1.2, end: 1.6 },
      ],
    }],
  }, 32_000);
  assert.equal(evidence.length, 1);
  assert.deepEqual(
    { startSample: evidence[0]!.startSample, endSampleExclusive: evidence[0]!.endSampleExclusive },
    { startSample: 1_600, endSampleExclusive: 28_800 },
  );
  assert.deepEqual(evidence[0]!.words, [
    { text: "hello", startSample: 1_600, endSampleExclusive: 6_400, score: 0.99 },
    { text: "crossing", startSample: 14_400, endSampleExclusive: 17_600, score: 0.8 },
    { text: "world", startSample: 19_200, endSampleExclusive: 25_600 },
  ]);
});

test("local Provider stages canonical evidence bytes unchanged and returns sealed alignment evidence", async () => {
  const expected = wav(32_000);
  let stagedMatches = false;
  let server: Server | undefined;
  await new Promise<void>((resolveReady, rejectReady) => {
    server = createServer(async (request, response) => {
      const url = request.url ?? "/";
      if (url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          protocol: "hypit.whisperx-service@1",
          serviceVersion: "0.1.0",
          whisperxVersion: "3.8.6",
          model: "small",
          device: "cpu",
          compute: "int8",
          batchSize: 8,
        }));
        return;
      }
      if (url !== "/transcribe") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly audio_path: string };
      stagedMatches = Buffer.compare(Buffer.from(await readFile(body.audio_path)), Buffer.from(expected)) === 0;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        language: "en",
        segments: [{ start: 0, end: 2, words: [
          { text: "hello", start: 0.1, end: 0.4 },
          { text: "world", start: 1.2, end: 1.6 },
        ] }],
      }));
    });
    server.listen(0, "127.0.0.1", () => resolveReady());
    server.on("error", rejectReady);
  });
  const address = server!.address();
  if (address === null || typeof address === "string") throw new Error("WhisperX test server failed to bind");
  try {
    const resources = new MemoryResourceStore();
    const artifact = await resources.put(expected, "audio/wav");
    const evidenceAudio = sealSpeechEvidenceAudio({
      artifact,
      sampleFrames: 32_000,
    });
    const constraints = whisperXRequestForEvidenceAudio(evidenceAudio, { language: "en" });
    const need: Need = {
      id: "need:whisperx-loopback",
      capability: whisperXCapabilities.alignment,
      returns: speechEvidenceTypes.alignedTranscript,
      constraints,
      result: "record:whisperx-loopback",
    };
    const registry = new EndpointRegistry();
    await createLocalWhisperXProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      expectedModel: "small",
      expectedDevice: "cpu",
    }).install(registry);
    const resolved = registry.resolve(need);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.registration.kind, "immediate");
    const output = await resolved.registration.handler({
      command: { kind: "fulfill-need", id: "command:whisperx-loopback", need },
      need,
      resources,
      credentials: {},
    });
    assert.equal(stagedMatches, true);
    assert.equal(output.value.kind, "inline");
    const value = output.value.kind === "inline" ? output.value.value : null;
    assert.equal((value as { readonly passages?: readonly unknown[] }).passages?.length, 1);
    assert.equal(speechTypes.evidenceAudio.name, "SpeechEvidenceAudio");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server!.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  }
});
