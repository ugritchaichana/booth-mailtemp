export const TARGET_URL = "https://mail.booth.pp.ua/";
export const REDIRECT_SECONDS = 10;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="${REDIRECT_SECONDS};url=${TARGET_URL}">
<title>Moved to mail.booth.pp.ua</title>
<style>
:root{--bg:#f4f6f8;--card:#fff;--text:#1f2933;--line:#dde3e8;--head:#2c3e50;--accent:#2c3e50;--accent-text:#fff;--track:#dde3e8}
@media (prefers-color-scheme:dark){:root{--bg:#121820;--card:#1b2530;--text:#e6ebf0;--line:#2c3947;--accent:#6c9bd1;--accent-text:#0e1620;--track:#2c3947}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif}
header{background:var(--head);color:#fff;padding:14px 20px;font-weight:600;letter-spacing:.2px}
main{max-width:560px;margin:0 auto;padding:32px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px 20px}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 12px}
p{margin:12px 0}
.bar{height:8px;border-radius:4px;background:var(--track);overflow:hidden;margin:20px 0}
.bar i{display:block;height:100%;width:0;background:var(--accent);animation:fill ${REDIRECT_SECONDS}s linear forwards}
@keyframes fill{to{width:100%}}
@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%}}
.go{display:block;text-align:center;background:var(--accent);color:var(--accent-text);text-decoration:none;font-weight:700;font-size:1.2rem;padding:14px 20px;border-radius:10px}
.go:hover,.go:focus-visible{filter:brightness(1.12);outline:3px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<header>Mailpit</header>
<main>
<div class="card">
<h1>Moved to mail.booth.pp.ua</h1>
<p>Email addresses are unchanged. Redirecting in ${REDIRECT_SECONDS} seconds.</p>
<div class="bar" role="progressbar" aria-label="Redirecting"><i></i></div>
<a class="go" href="${TARGET_URL}">Go now</a>
</div>
</main>
<script>setTimeout(function(){location.replace("${TARGET_URL}")},${REDIRECT_SECONDS * 1000})</script>
</body>
</html>
`;

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

const wantsJson = (url, request) =>
  url.pathname.startsWith("/api/") ||
  url.pathname.startsWith("/admin/api/") ||
  (request.headers.get("Accept") ?? "").toLowerCase().includes("application/json");

export const handle = (request) => {
  if (wantsJson(new URL(request.url), request)) {
    return new Response(JSON.stringify({ error: "moved", to: TARGET_URL }), {
      status: 410,
      headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
    });
  }
  return new Response(PAGE, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
};

export default { fetch: (request) => handle(request) };
