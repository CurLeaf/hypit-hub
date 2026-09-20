import type { EndpointInvocationContext } from "@hypit/endpoint-kit";
import type { BlobRef } from "@hypit/protocol";

import type { OpenAiCompatibleClient } from "./client.js";

export async function uploadArtifactUrl(
  client: OpenAiCompatibleClient,
  secret: string,
  artifact: BlobRef,
  resources: EndpointInvocationContext["resources"],
): Promise<string> {
  const bytes = await resources.get(artifact.resource);
  if (bytes === undefined) throw new Error("Reference media is unavailable");
  const mediaType = artifact.mediaType ?? "application/octet-stream";
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
