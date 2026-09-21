import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Load `<workspace>/.env` into `process.env` without overwriting existing variables. */
export async function loadWorkspaceEnv(workspaceRoot: string): Promise<void> {
  try {
    const text = await readFile(join(workspaceRoot, ".env"), "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key.length === 0 || process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  } catch {
    // optional .env
  }
}
