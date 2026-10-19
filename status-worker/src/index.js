export const TARGET_URL = "https://mail.booth.pp.ua/";

const PAGE = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>ระบบย้ายไปที่ mail.booth.pp.ua แล้ว</title>
<style>
:root{--bg:#f4f6f8;--card:#fff;--text:#1f2933;--muted:#5b6770;--line:#dde3e8;--head:#2c3e50;--accent:#2c3e50;--accent-text:#fff;--note:#eef3f8}
@media (prefers-color-scheme:dark){:root{--bg:#121820;--card:#1b2530;--text:#e6ebf0;--muted:#9aa7b3;--line:#2c3947;--head:#2c3e50;--accent:#6c9bd1;--accent-text:#0e1620;--note:#222f3c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif}
header{background:var(--head);color:#fff;padding:14px 20px;font-weight:600;letter-spacing:.2px}
main{max-width:720px;margin:0 auto;padding:24px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px 20px}
h1{font-size:1.6rem;line-height:1.3;margin:0 0 20px}
h2{font-size:1.1rem;margin:28px 0 8px}
.go{display:block;text-align:center;background:var(--accent);color:var(--accent-text);text-decoration:none;font-weight:700;font-size:1.25rem;padding:16px 20px;border-radius:10px}
.go:hover,.go:focus-visible{filter:brightness(1.12);outline:3px solid var(--accent);outline-offset:2px}
.note{background:var(--note);border-radius:10px;padding:12px 14px;margin:16px 0 0}
p{margin:12px 0}
ul{margin:0;padding-left:1.3rem}
li{margin:6px 0}
code{font-family:ui-monospace,Consolas,monospace;font-size:.95em}
.en{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.95rem}
@media (max-width:480px){h1{font-size:1.35rem}.card{padding:20px 16px}}
</style>
</head>
<body>
<header>Mailpit</header>
<main>
<div class="card">
<h1>ระบบย้ายไปที่ mail.booth.pp.ua แล้ว</h1>
<a class="go" href="${TARGET_URL}">ไปที่ mail.booth.pp.ua</a>
<p class="note">ที่อยู่อีเมลยังเหมือนเดิม: <code>ชื่อ@booth.pp.ua</code> (รวมแบบ <code>ชื่อ+tag</code>) ใช้ต่อได้เลย<br>เมลเก่าย้ายไปครบแล้ว พร้อมวันที่เดิม</p>
<p><strong>สิ่งที่ต้องทำ:</strong> เพิ่มที่อยู่ที่เคยใช้อีกครั้งในหน้าใหม่ (รายการที่อยู่ที่บันทึกไว้ในเบราว์เซอร์ไม่ย้ายตาม)</p>
<h2>อะไรเปลี่ยนไป</h2>
<ul>
<li>เดิม: ระบบรันบนเครื่องของ Booth (localhost) ใช้ได้เฉพาะตอนเครื่องเปิด</li>
<li>ตอนนี้: รันบน Cloudflare</li>
</ul>
<h2>ข้อดี</h2>
<ul>
<li>ใช้งานได้ตลอด 24 ชั่วโมง ไม่ต้องรอ Booth เปิดเครื่อง</li>
<li>เมลเข้าตรงที่ Cloudflare ไม่ต้องผ่านเครื่องใคร</li>
</ul>
<h2>ข้อจำกัด</h2>
<ul>
<li>พื้นที่เก็บเมลรวมประมาณ 400 MB เมื่อเต็ม ระบบจะลบเมลที่เก่าที่สุดก่อนโดยอัตโนมัติ ถ้าต้องเก็บเมลไว้นาน ให้ดาวน์โหลดเก็บไว้เอง</li>
<li>เมลที่ใหญ่เกิน 25 MB รับไม่ได้ (เท่าเดิม)</li>
<li>ใช้แผนฟรีของ Cloudflare ซึ่งมีโควตารายวัน ถ้าใช้งานหนักผิดปกติ ระบบอาจหยุดชั่วคราวจนถึง 07:00 น. (เวลาไทย)</li>
<li>หน้า Mailpit admin (<code>/admin</code>) เดิมเลิกใช้แล้ว</li>
</ul>
<p class="en" lang="en">This service has moved to mail.booth.pp.ua. Email addresses (@booth.pp.ua) are unchanged.</p>
</div>
</main>
</body>
</html>
`;

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const PAGE_PATHS = new Set(["/", "/index.html"]);

const wantsJson = (url, request) =>
  url.pathname.startsWith("/api/") ||
  url.pathname.startsWith("/admin/api/") ||
  (request.headers.get("Accept") ?? "").toLowerCase().includes("application/json");

export const handle = (request) => {
  const url = new URL(request.url);
  if (wantsJson(url, request)) {
    return new Response(JSON.stringify({ error: "moved", to: TARGET_URL }), {
      status: 410,
      headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
    });
  }
  return new Response(PAGE, {
    status: PAGE_PATHS.has(url.pathname) ? 200 : 410,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
};

export default { fetch: (request) => handle(request) };
