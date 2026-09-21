import type { EndpointInvocationContext } from "@hypit/endpoint-kit";
import type { BlobRef } from "@hypit/protocol";

import type { OpenAiCompatibleClient } from "./client.js";
import {
  putS3PublicObject,
  s3PublicObjectKey,
  type S3PublicUploadConfig,
} from "./s3-public-upload.js";

export type ResolveArtifactUrl = (
  artifact: BlobRef,
  resources: EndpointInvocationContext["resources"],
  secret: string,
) => Promise<string>;

function objectId(artifact: BlobRef): string {
  const raw = String(artifact.resource).replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return raw.length > 0 ? raw.slice(-48) : "reference";
}

async function readBytes(
  artifact: BlobRef,
  resources: EndpointInvocationContext["resources"],
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  const bytes = await resources.get(artifact.resource);
  if (bytes === undefined) throw new Error("Reference media is unavailable");
  return { bytes, mediaType: artifact.mediaType ?? "application/octet-stream" };
}

export async function uploadArtifactUrl(
  client: OpenAiCompatibleClient,
  secret: string,
  artifact: BlobRef,
  resources: EndpointInvocationContext["resources"],
): Promise<string> {
  const { bytes, mediaType } = await readBytes(artifact, resources);
  const response = await client.json("/files", secret, {
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

export function createArtifactUrlResolver(
  client: OpenAiCompatibleClient,
  referenceUpload?: S3PublicUploadConfig,
): ResolveArtifactUrl {
  if (referenceUpload === undefined) {
    return async (artifact, resources, secret) =>
      await uploadArtifactUrl(client, secret, artifact, resources);
  }
  return async (artifact, resources) => {
    const { bytes, mediaType } = await readBytes(artifact, resources);
    return await putS3PublicObject(referenceUpload, {
      bytes,
      mediaType,
      key: s3PublicObjectKey(referenceUpload, mediaType, objectId(artifact)),
      fetch: client.fetcher,
    });
  };
}
