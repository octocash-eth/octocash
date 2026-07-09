/**
 * Delora API base URL + headers.
 *
 * `api.delora.build` serves CORS headers for any origin, including the
 * `x-api-key` request header, so browser calls go direct — no proxy hop.
 * When `VITE_DELORA_API_KEY` is set we send it via `x-api-key`, which raises
 * the per-IP rate limit from 200 requests / 2 hours to 200 requests / minute
 * (see https://docs.delora.build/api-reference/rate-limits).
 *
 * Resolved on every call (not module-load) so `vi.stubEnv` in tests takes
 * effect without re-importing the module.
 */

function getApiKey(): string | undefined {
  const key = import.meta.env.VITE_DELORA_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

export function deloraBaseUrl(): string {
  return "https://api.delora.build";
}

export function deloraHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const key = getApiKey();
  if (key) headers["x-api-key"] = key;
  return headers;
}
