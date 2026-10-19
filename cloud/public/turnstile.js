const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const CHALLENGE_TIMEOUT_MS = 90_000;
let config = null;
let script = null;

export async function loadConfig() {
  if (config) return config;
  const res = await fetch("/api/config", { cache: "no-store" });
  if (!res.ok) throw new Error("config unavailable");
  config = await res.json();
  return config;
}

function loadScript() {
  script ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const el = document.createElement("script");
    el.src = SCRIPT;
    el.async = true;
    el.onload = () => resolve(window.turnstile);
    el.onerror = () => { script = null; el.remove(); reject(new Error("bot check could not load")); };
    document.head.append(el);
  });
  return script;
}

export async function tokenFor(host, action) {
  const { turnstileSiteKey } = await loadConfig();
  if (!turnstileSiteKey) return null;
  const turnstile = await loadScript();
  const slot = document.createElement("div");
  host.replaceChildren(slot);
  return new Promise((resolve, reject) => {
    let widget = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      setTimeout(() => { try { turnstile.remove(widget); } catch {} slot.remove(); }, 0);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("bot check timed out")), CHALLENGE_TIMEOUT_MS);
    widget = turnstile.render(slot, {
      sitekey: turnstileSiteKey,
      action,
      appearance: "interaction-only",
      callback: (token) => finish(resolve, token),
      "error-callback": () => { finish(reject, new Error("bot check failed")); return true; },
      "timeout-callback": () => finish(reject, new Error("bot check timed out")),
    });
  });
}

export const BOT_CHECK_ERROR = "The bot check could not run. Check your connection or ad blocker, then try again.";
