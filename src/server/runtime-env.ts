// Nitro's Cloudflare adapter passes runtime bindings to the worker fetch handler.
// Keep a server-only copy so request handlers can read secrets that are not
// present in Node's process.env shim. Bindings are stable for a deployment, and
// values never leave this module.

let runtimeBindings: Readonly<Record<string, string>> = Object.freeze({});

export function setRuntimeEnv(source: unknown): void {
  if (!source || typeof source !== "object") return;

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === "string") next[key] = value;
  }
  runtimeBindings = Object.freeze(next);
}

export function readRuntimeEnv(): Record<string, string | undefined> {
  const processEnv =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)
      : {};

  // Runtime bindings take precedence over build-time variables.
  return { ...processEnv, ...runtimeBindings };
}

export function clearRuntimeEnvForTests(): void {
  runtimeBindings = Object.freeze({});
}
