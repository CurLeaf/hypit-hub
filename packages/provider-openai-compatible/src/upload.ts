import type { EndpointInvocationContext } from "@hypit/endpoint-kit";
import type { BlobRef } from "@hypit/protocol";

import type { OpenAiCompatibleClient } from "./client.js";

function uploadFilename(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": "reference.png",
    "image/jpeg": "reference.jpg",
    "image/webp": "reference.webp",
    "audio/wav": "reference.wav",
    "audio/mpeg": "reference.mp3",
    "video/mp4": "reference.mp4",
  };
  return map[mediaType] ?? "reference.bin";
}

function minimaxFileId(response: Record<string, unknown>): string {
  const file = response.file;
  if (file !== null && typeof file === "object" && !Array.isArray(file)) {
    const nested = (file as Record<string, unknown>).file_id;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  const direct = response.file_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  throw new Error("MiniMax upload did not return file_id");
}

async function uploadMinimaxArtifactUrl(
  client: OpenAiCompatibleClient,
  secret: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<string> {
  const form = new FormData();
  form.append("purpose", "video_generation_input");
  form.append("file", new Blob([bytes], { type: mediaType }), uploadFilename(mediaType));
  const response = await client.json(client.routes.fileUpload, secret, {
    method: "POST",
    body: form,
  });
  return `mm_file://${minimaxFileId(response)}`;
}

export async function uploadArtifactUrl(
  client: OpenAiCompatibleClient,
  secret: string,
  artifact: BlobRef,
  resources: EndpointInvocationContext["resources"],
): Promise<string> {
  const bytes = await resources.get(artifact.resource);
  if (bytes === undefined) throw new Error("Reference media is unavailable");
  const mediaType = artifact.mediaType ?? "application/octet-stream";
  if (client.uploadMode === "minimax-multipart") {
    return await uploadMinimaxArtifactUrl(client, secret, bytes, mediaType);
  }
  const response = await client.json(client.routes.fileUpload, secret, {
    method: "POST",
    headers: { "content-type": mediaType },
    body: new Blob([new Uint8Array(bytes)]),
  });
  const url = response.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("OpenAI-compatible upload did not return a URL");
  }
  return url;
}
