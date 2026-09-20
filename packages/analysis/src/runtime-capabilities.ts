import { readFile } from "node:fs/promises";

export type RuntimeCapabilities = {
  readonly fishSpeech: boolean;
  readonly h3Video: boolean;
};

const FISH_BINDING_PREFIX = "@hypit/fishaudio-speech@";
const H3_BINDING_PREFIX = "@hypit/minimax-h3@";

export async function loadRuntimeCapabilities(runtimePath?: string): Promise<RuntimeCapabilities> {
  if (runtimePath === undefined) {
    return { fishSpeech: false, h3Video: true };
  }
  try {
    const raw = JSON.parse(await readFile(runtimePath, "utf8")) as {
      bindings?: Record<string, string>;
    };
    const keys = Object.keys(raw.bindings ?? {});
    return {
      fishSpeech: keys.some((key) => key.startsWith(FISH_BINDING_PREFIX)),
      h3Video: keys.some((key) => key.startsWith(H3_BINDING_PREFIX)),
    };
  } catch {
    return { fishSpeech: false, h3Video: true };
  }
}
