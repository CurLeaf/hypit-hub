const ENV_REF = /^\$\{([A-Z][A-Z0-9_]*)\}$/u;
const ENV_BARE = /^\$([A-Z][A-Z0-9_]*)$/u;

export function envRefName(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return ENV_REF.exec(trimmed)?.[1] ?? ENV_BARE.exec(trimmed)?.[1];
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as { store?: unknown; key?: unknown };
    if (object.store === "env" && typeof object.key === "string") {
      const key = object.key.trim();
      return key.length === 0 ? undefined : key;
    }
  }
  return undefined;
}

/** A Profile string, `$NAME` / `${NAME}`, or `{ store: "env", key: "NAME" }`. */
export function resolveGatewayText(
  value: unknown,
  env: NodeJS.Dict<string> = process.env,
): string | undefined {
  const name = envRefName(value);
  if (name !== undefined) {
    const resolved = env[name]?.trim();
    return resolved === undefined || resolved.length === 0 ? undefined : resolved;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
