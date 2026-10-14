const PAGE_PATHS = new Set(["/", "/index.html"]);
const RETRY_SECONDS = 15;

const isOriginDown = (status) => status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);

const LOGO = `<svg viewBox="0 0 132.292 121.708" width="56" height="52" aria-hidden="true"><path d="M12.321 0l53.861 53.918L120.365 0zM5.155 9.025l60.842 59.673 61.211-59.489-.185 36.835L66.921 70.54l15.164 12.616-8.137 5.986-41.609.184c-4.838-.022-25.877-18.34-27.185-41.255z" fill="#fff"/><path d="M78.385 72.049l53.907-21.679-8.031 57.318-11.845-9.132c-21.727 23.171-45.255 26.289-67.997 20.837S12.281 98.39 5.155 83.8-.67 53.116 2.843 38.769c1.13 10.511-1.313 16.316 6.38 33.612 6.31 11.399 14.413 20.417 25.89 24.956 13.9 6.195 32.247 3.357 41.701-3.039l14.24-12.156z" fill="#00b786"/></svg>`;

export const fallbackPage = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Mailpit - system is down</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#212529;--card:#fff;--line:#dee2e6;--muted:#6c757d}
@media (prefers-color-scheme:dark){:root{--bg:#212529;--fg:#e7eaed;--card:#2b3035;--line:#495057;--muted:#adb5bd}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--fg)}
header svg{width:36px;height:34px}
header{background:#2c3e50;color:#fff;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:1.25rem}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:16px}
.card{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;text-align:center}
.logo{display:inline-block;background:#2c3e50;border-radius:10px;padding:8px}
h1{font-size:1.4rem;margin:12px 0 4px}
.alert{margin:16px 0 0;padding:10px 12px;border-radius:6px;background:#f8d7da;color:#842029;border:1px solid #f1aeb5}
@media (prefers-color-scheme:dark){.alert{background:#2c0b0e;color:#ea868f;border-color:#842029}}
.muted{color:var(--muted);font-size:.875rem;margin-top:12px}
</style>
</head>
<body>
<header>${LOGO}<span>Mailpit</span></header>
<main>
<div class="card">
<span class="logo">${LOGO}</span>
<h1>System is down</h1>
<div class="alert" role="alert">The mail service is down. Your mail is safe and queued, and will arrive when the service is back.</div>
<p class="muted">Checking again every ${RETRY_SECONDS} seconds. This page reloads by itself when the service recovers.</p>
</div>
</main>
<script>
setInterval(function () {
  fetch(location.href, { cache: "no-store" }).then(function (res) { if (res.ok) location.reload(); }).catch(function () {});
}, ${RETRY_SECONDS * 1000});
</script>
</body>
</html>`;

const fallbackResponse = () =>
  new Response(fallbackPage(), {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(RETRY_SECONDS), "X-Content-Type-Options": "nosniff" },
  });

export async function handle(request, originFetch = fetch) {
  const { pathname } = new URL(request.url);
  if (!PAGE_PATHS.has(pathname)) return originFetch(request);
  try {
    const response = await originFetch(request);
    return isOriginDown(response.status) ? fallbackResponse() : response;
  } catch {
    return fallbackResponse();
  }
}

export default { fetch: (request) => handle(request) };
