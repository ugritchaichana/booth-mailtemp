const env = (name, fallback) => process.env[name] ?? fallback;
const need = (name) => {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const mailpit = env("MAILPIT_URL", "http://127.0.0.1:8025/admin").replace(/\/$/, "");
const auth = `Basic ${Buffer.from(`${need("MAILPIT_USER")}:${need("MAILPIT_PASSWORD")}`).toString("base64")}`;
const target = env("IMPORT_URL") ? env("IMPORT_URL").replace(/\/$/, "") : null;
const token = env("IMPORT_TOKEN");
const domain = env("MAIL_DOMAIN", "booth.pp.ua").toLowerCase();
const dryRun = env("DRY_RUN") === "1";
const PAGE = 50;
const ATTEMPTS = 4;

if (!dryRun && (!target || !token)) throw new Error("IMPORT_URL and IMPORT_TOKEN are required unless DRY_RUN=1");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mailpitGet(path, as = "json") {
  const res = await fetch(`${mailpit}/api/v1${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`mailpit ${path.split("?")[0]} -> ${res.status}`);
  return as === "json" ? res.json() : Buffer.from(await res.arrayBuffer());
}

async function* messages() {
  for (let start = 0; ; start += PAGE) {
    const page = await mailpitGet(`/messages?start=${start}&limit=${PAGE}`);
    yield* page.messages;
    if (!page.messages.length || start + page.messages.length >= page.messages_count) return;
  }
}

const recipientsOf = (summary) => [...new Set(["To", "Cc", "Bcc"]
  .flatMap((field) => summary[field] ?? [])
  .map((p) => String(p.Address ?? "").trim().toLowerCase())
  .filter((a) => a.slice(a.lastIndexOf("@") + 1) === domain && a.lastIndexOf("@") > 0))];

async function send(raw, recipients, createdAt) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${target}/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822", "X-Envelope-To": recipients.join(","), "X-Created-At": createdAt },
        body: raw,
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      last = new Error(`import -> ${res.status} ${body.error ?? ""}`.trim());
      if (res.status < 500) throw last;
    } catch (err) {
      last = err;
      if (/-> 4\d\d/.test(String(err.message))) throw err;
    }
    await pause(1000 * attempt);
  }
  throw last;
}

const totals = { seen: 0, stored: 0, duplicate: 0, skipped: 0, failed: 0, bytes: 0 };
for await (const summary of messages()) {
  totals.seen += 1;
  const recipients = recipientsOf(summary);
  if (!recipients.length) {
    totals.skipped += 1;
    console.log(`${summary.ID} size=${summary.Size} skipped no-recipient-on-domain`);
    continue;
  }
  try {
    const raw = await mailpitGet(`/message/${summary.ID}/raw`, "bytes");
    if (dryRun) {
      console.log(`${summary.ID} size=${raw.length} dry-run recipients=${recipients.length} created=${summary.Created}`);
      continue;
    }
    const result = await send(raw, recipients, summary.Created);
    const state = result.stored === false ? "not-stored" : result.duplicate ? "duplicate" : "stored";
    totals[state === "not-stored" ? "skipped" : state] += 1;
    totals.bytes += raw.length;
    console.log(`${summary.ID} size=${raw.length} ${state} cloud-id=${result.id ?? "-"}${result.reason ? ` reason=${result.reason}` : ""}`);
  } catch (err) {
    totals.failed += 1;
    console.log(`${summary.ID} size=${summary.Size} failed ${String(err.message).slice(0, 120)}`);
  }
}
console.log(`done ${JSON.stringify(totals)}`);
process.exitCode = totals.failed ? 1 : 0;
