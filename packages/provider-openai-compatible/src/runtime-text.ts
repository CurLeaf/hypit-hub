import type { CanonicalValue } from "@hypit/protocol";
import { runtimeConfigCredentialRef, runtimeConfigString } from "@hypit/runtime-kit";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const ENV_REF = /^\$\{([A-Z][A-Z0-9_]*)\}$/u;
const ENV_BARE = /^\$([A-Z][A-Z0-9_]*)$/u;

function envText(name: string, env: NodeJS.Dict<string>, subject: string): string {
  if (!ENV_NAME.test(name)) throw new Error(`${subject} env name is invalid`);
  const resolved = env[name]?.trim();
  if (resolved === undefined || resolved.length === 0) {
    throw new Error(`${subject} env ${name} is missing`);
  }
  return resolved;
}

/**
 * A Profile string, `$NAME` / `${NAME}`, or `{ store: "env", key: "NAME" }`.
 * Used for non-secret addresses such as `H3_VIDEO_BASE_URL`.
 */
export function resolveRuntimeText(
  value: CanonicalValue | undefined,
  subject: string,
  env: NodeJS.Dict<string> = process.env,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const name = ENV_REF.exec(trimmed)?.[1] ?? ENV_BARE.exec(trimmed)?.[1];
    if (name !== undefined) return envText(name, env, subject);
    return runtimeConfigString(value, subject);
  }
  const ref = runtimeConfigCredentialRef(value, subject);
  if (ref === undefined) return undefined;
  if (ref.store !== "env") throw new Error(`${subject} store must be env`);
  return envText(ref.key, env, subject);
}
