const DEFAULT_STATUS_URL = "https://mailpit.booth.pp.ua/api/status";
const STATUS_PAGE_URL = "https://mailpit.booth.pp.ua/";
const STATE_KEY = "state";
const PROBE_TIMEOUT_MS = 8000;
const POST_TIMEOUT_MS = 8000;
const DOWN_AFTER_FAILURES = 2;
const REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000;
const KEY_COUNT_LIMIT = 1000;

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
const short = (value) => String(value).slice(0, 60);

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

export async function probe(statusUrl, fetchFn) {
  try {
    const res = await fetchFn(statusUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, detail: "HTTP 200 with a non-JSON body" };
    }
    const bad = ["mailpit", "bridge"].filter((name) => body?.[name] !== "ok");
    if (bad.length === 0) return { ok: true, detail: "ok" };
    return { ok: false, detail: bad.map((name) => `${name}=${short(body?.[name])}`).join(", ") };
  } catch (err) {
    return { ok: false, detail: `probe error: ${short(err?.name ?? err)}` };
  }
}

async function countBufferedMail(env) {
  try {
    const { keys, list_complete } = await env.CAPTURE_FALLBACK.list({ limit: KEY_COUNT_LIMIT });
    return list_complete ? String(keys.length) : `${keys.length}+`;
  } catch {
    return "unknown";
  }
}

async function post(env, kind, content, fetchFn) {
  try {
    const url = new URL(env.ALERT_WEBHOOK_URL);
    url.searchParams.set("wait", "true");
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    let messageId;
    try {
      messageId = (await res.json())?.id;
    } catch {
      messageId = undefined;
    }
    const ok = res.status >= 200 && res.status <= 299;
    log(ok ? "MONITOR_ALERT_SENT" : "MONITOR_ALERT_FAILED", { kind, status: res.status, messageId });
    return ok;
  } catch (err) {
    log("MONITOR_ALERT_FAILED", { kind, error: short(err?.name ?? "error") });
    return false;
  }
}

async function loadState(env) {
  try {
    return (await env.MONITOR_STATE.get(STATE_KEY, "json")) ?? { failures: 0 };
  } catch (err) {
    log("MONITOR_STATE_ERROR", { stage: "read", error: String(err) });
    return null;
  }
}

async function saveState(env, state) {
  try {
    await env.MONITOR_STATE.put(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    log("MONITOR_STATE_ERROR", { stage: "write", error: String(err) });
  }
}

export async function runMonitor(env, { fetch: fetchFn = fetch, now = Date.now() } = {}) {
  if (!env.ALERT_WEBHOOK_URL) return log("MONITOR_DISABLED", { reason: "ALERT_WEBHOOK_URL is not set" });
  if (!env.MONITOR_STATE) return log("MONITOR_DISABLED", { reason: "MONITOR_STATE binding is missing" });

  const state = await loadState(env);
  if (!state) return;
  const result = await probe(env.STATUS_URL || DEFAULT_STATUS_URL, fetchFn);
  const next = { ...state };

  if (result.ok) {
    if (state.down) {
      const buffered = await countBufferedMail(env);
      const content = `🟢 **mailtemp RECOVERED** after ${formatDuration(now - state.firstFailureAt)} down. Mails buffered in KV: ${buffered}. Status: ${STATUS_PAGE_URL}`;
      if (!(await post(env, "recovered", content, fetchFn))) return;
    }
    if (state.failures > 0 || state.down) await saveState(env, { failures: 0 });
    return;
  }

  next.failures = Math.min(state.failures + 1, DOWN_AFTER_FAILURES);
  next.firstFailureAt = state.firstFailureAt ?? now;
  log("MONITOR_PROBE_FAILED", { detail: result.detail, failures: next.failures });

  if (next.failures >= DOWN_AFTER_FAILURES && !state.down) {
    const content = `🔴 **mailtemp DOWN** since ${new Date(next.firstFailureAt).toISOString()}. Reason: ${result.detail}. Inbound mail is buffered in KV for up to 7 days. Status: ${STATUS_PAGE_URL}`;
    if (await post(env, "down", content, fetchFn)) Object.assign(next, { down: true, lastAlertAt: now });
  } else if (state.down && now - state.lastAlertAt >= REMINDER_INTERVAL_MS) {
    const content = `🔴 **mailtemp still DOWN** after ${formatDuration(now - state.firstFailureAt)}. Reason: ${result.detail}. Status: ${STATUS_PAGE_URL}`;
    if (await post(env, "reminder", content, fetchFn)) next.lastAlertAt = now;
  }

  if (JSON.stringify(next) !== JSON.stringify(state)) await saveState(env, next);
}

export async function runMonitorSafely(env) {
  try {
    await runMonitor(env);
  } catch (err) {
    log("MONITOR_ERROR", { error: String(err) });
  }
}
