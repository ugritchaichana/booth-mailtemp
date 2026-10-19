import { fail, log } from "./http.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_MAX = 2048;

export const turnstileOn = (env) => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);

async function verify(env, token, ip) {
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(ip === "unknown" ? {} : { remoteip: ip }) }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function botCheck(env, request, ip, action) {
  if (!turnstileOn(env)) return null;
  const token = request.headers.get("x-turnstile-token") ?? "";
  if (!token || token.length > TOKEN_MAX) return fail(403, "bot check failed");
  const result = await verify(env, token, ip);
  if (!result) {
    log("turnstile_unavailable", { action });
    return fail(503, "bot check unavailable, try again");
  }
  const testingKey = result.metadata?.result_with_testing_key === true;
  const hostOk = testingKey || !result.hostname || result.hostname === new URL(request.url).hostname;
  const actionOk = !result.action || result.action === action;
  if (result.success === true && hostOk && actionOk) return null;
  log("turnstile_rejected", { action, codes: (result["error-codes"] ?? []).slice(0, 5).map(String), hostOk, actionOk });
  return fail(403, "bot check failed");
}
