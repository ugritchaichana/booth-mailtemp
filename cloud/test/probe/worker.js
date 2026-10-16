const encoder = new TextEncoder();
const MIB = 1024 * 1024;

function tile(block, length) {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += block.length) out.set(block.subarray(0, Math.min(block.length, length - at)), at);
  return out;
}

function base64Lines(seed) {
  const line = btoa(String.fromCharCode(...Array.from({ length: 57 }, (_, i) => (seed * 31 + i * 7) & 0xff)));
  return encoder.encode(`${line}\r\n`.repeat(900));
}

export function buildMessage({ size, to, subject, id }) {
  const boundary = `probe-${id}`;
  const head = [
    "From: Probe <probe@example.com>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@probe.example.com>`,
    "Date: Fri, 16 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");
  const intro = encoder.encode(`${head}\r\n\r\n--${boundary}\r\nContent-Type: multipart/alternative; boundary="alt-${id}"\r\n\r\n--alt-${id}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nProbe message ${id}\r\n--alt-${id}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><h1>Probe ${id}</h1><p>generated test mail</p></body></html>\r\n--alt-${id}--\r\n--${boundary}\r\nContent-Type: application/pdf; name="probe.pdf"\r\nContent-Disposition: attachment; filename="probe.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
  const outro = encoder.encode(`\r\n--${boundary}--\r\n`);
  const filler = Math.max(size - intro.length - outro.length, 0);
  const body = tile(base64Lines(size % 251), filler);
  const out = new Uint8Array(intro.length + body.length + outro.length);
  out.set(intro);
  out.set(body, intro.length);
  out.set(outro, intro.length + body.length);
  return out;
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__probe/")) return env.CLOUD.fetch(request);
    if (!env.PROBE_TOKEN || request.headers.get("x-probe-token") !== env.PROBE_TOKEN) return new Response("forbidden", { status: 403 });
    const size = Number(url.searchParams.get("size") ?? 100_000);
    const to = url.searchParams.get("to") ?? "cloudcheck@booth.pp.ua";
    const id = url.searchParams.get("id") ?? crypto.randomUUID();
    const subject = url.searchParams.get("subject") ?? `probe ${size}`;
    const raw = buildMessage({ size, to, subject, id });
    const sha = size <= MIB ? hex(await crypto.subtle.digest("SHA-256", raw)) : null;
    const envelope = { from: "probe@example.com", to: to.split(",").map((a) => a.trim()) };
    const started = Date.now();
    try {
      const payload = url.searchParams.get("stream") === "1" ? new Response(raw).body : raw.buffer;
      const result = await env.CLOUD.ingest(payload, envelope);
      return Response.json({ ok: true, size: raw.length, sha256: sha, result, wallMs: Date.now() - started });
    } catch (err) {
      return Response.json({ ok: false, size: raw.length, error: String(err?.message ?? err), wallMs: Date.now() - started }, { status: 500 });
    }
  },
};
