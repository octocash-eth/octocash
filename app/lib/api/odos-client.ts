/**
 * Odos API base URL + headers.
 *
 * When `VITE_ODOS_API_KEY` is set we route to `enterprise-api.odos.xyz` and
 * send the key via the `x-api-key` header, per
 * https://docs.odos.xyz/home/api-monetization. The enterprise host doesn't
 * return CORS headers, so we tunnel through the same `cors.blossom.deno.net`
 * proxy that `zerion.ts` uses for browser calls. Without a key we fall back
 * to the unauthenticated `api.odos.xyz` host (which serves CORS natively) so
 * dev/test builds without a key still work.
 *
 * Resolved on every call (not module-load) so `vi.stubEnv` in tests takes
 * effect without re-importing the module.
 */

const CORS_PROXY = "https://cors.blossom.deno.net/v0";

function getApiKey(): string | undefined {
  const key = import.meta.env.VITE_ODOS_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

export function odosBaseUrl(): string {
  return getApiKey() ? `${CORS_PROXY}/https://enterprise-api.odos.xyz` : "https://api.odos.xyz";
}

export function odosHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const key = getApiKey();
  if (key) headers["x-api-key"] = key;
  return headers;
}
