import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openD1 } from "./d1-shim.mjs";
import { CHUNK_BYTES, MAX_RAW_BYTES, hide, ingest, janitor, listFor, markRead, ownMessage, rawStream, resolveCreated, splitChunks } from "../src/store.js";

const DOMAIN = "booth.pp.ua";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function build({ to = "cloudcheck@booth.pp.ua", subject = "probe", id = crypto.randomUUID(), size = 2000, extra = [] } = {}) {
  const head = [`From: sender@example.com`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@example.com>`, `Date: Fri, 16 Oct 2026 10:00:00 +0000`, ...extra].join("\r\n");
  const body = crypto.randomBytes(Math.max(size - head.length - 4, 0));
  return new Uint8Array(Buffer.concat([Buffer.from(`${head}\r\n\r\n`), body]));
}

async function download(db, username, message) {
  const row = await ownMessage(db, username, message.id);
  if (!row) return null;
  return new Uint8Array(await new Response(rawStream(db, row, username, DOMAIN)).arrayBuffer());
}

test("chunks split on the size boundary and reassemble to the same bytes", () => {
  for (const size of [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, CHUNK_BYTES * 3 + 17]) {
    const bytes = crypto.randomBytes(size);
    const parts = splitChunks(new Uint8Array(bytes));
    assert.ok(parts.every((p) => p.length <= CHUNK_BYTES));
    assert.equal(sha(Buffer.concat(parts)), sha(bytes), `size ${size}`);
  }
});

test("a 5 MB message round-trips byte for byte through the chunk table", async () => {
  const db = openD1();
  const raw = build({ size: 5_000_000 });
  const result = await ingest(db, raw, { from: "sender@example.com", to: ["cloudcheck@booth.pp.ua"] }, DOMAIN);
  assert.equal(result.chunks, Math.ceil(5_000_000 / CHUNK_BYTES));
  const { messages } = await listFor(db, "cloudcheck", DOMAIN);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].size, raw.length);
  assert.equal(sha(await download(db, "cloudcheck", messages[0])), sha(raw));
});

test("the largest accepted message round-trips and one byte more is refused", async () => {
  const db = openD1();
  const raw = build({ size: MAX_RAW_BYTES });
  await ingest(db, raw, { to: ["cloudcheck@booth.pp.ua"] }, DOMAIN);
  const [one] = (await listFor(db, "cloudcheck", DOMAIN)).messages;
  assert.equal(sha(await download(db, "cloudcheck", one)), sha(raw));
  await assert.rejects(ingest(db, new Uint8Array(MAX_RAW_BYTES + 1), { to: ["cloudcheck@booth.pp.ua"] }, DOMAIN), /exceeds/);
});

test("a stream input gives the same stored bytes as a buffer", async () => {
  const db = openD1();
  const raw = build({ size: 300_000 });
  const stream = new ReadableStream({ start(c) { c.enqueue(raw.subarray(0, 1000)); c.enqueue(raw.subarray(1000)); c.close(); } });
  await ingest(db, stream, { to: ["cloudcheck@booth.pp.ua"] }, DOMAIN);
  const [one] = (await listFor(db, "cloudcheck", DOMAIN)).messages;
  assert.equal(sha(await download(db, "cloudcheck", one)), sha(raw));
});

test("a retried copy does not duplicate the message or its chunks", async () => {
  const db = openD1();
  const raw = build({ size: 4_000_000 });
  const envelope = { to: ["cloudcheck@booth.pp.ua"] };
  const first = await ingest(db, raw, envelope, DOMAIN);
  const again = await ingest(db, raw, envelope, DOMAIN);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").first("n"), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").first("n"), Math.ceil(4_000_000 / CHUNK_BYTES));
});

test("names are isolated, +tag mail shows under the base name only", async () => {
  const db = openD1();
  await ingest(db, build({ to: "alice@booth.pp.ua", subject: "for alice" }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  await ingest(db, build({ to: "alice+01@booth.pp.ua", subject: "for alice tag" }), { to: ["alice+01@booth.pp.ua"] }, DOMAIN);
  await ingest(db, build({ to: "alicia@booth.pp.ua", subject: "for alicia" }), { to: ["alicia@booth.pp.ua"] }, DOMAIN);
  await ingest(db, build({ to: "alice-b@booth.pp.ua", subject: "for alice-b" }), { to: ["alice-b@booth.pp.ua"] }, DOMAIN);
  const subjects = async (name) => (await listFor(db, name, DOMAIN)).messages.map((m) => m.subject).sort();
  assert.deepEqual(await subjects("alice"), ["for alice", "for alice tag"]);
  assert.deepEqual(await subjects("alice+01"), ["for alice tag"]);
  assert.deepEqual(await subjects("alicia"), ["for alicia"]);
  assert.deepEqual(await subjects("alice-b"), ["for alice-b"]);
  assert.deepEqual(await subjects("ali"), []);
  const [aliciaMail] = (await listFor(db, "alicia", DOMAIN)).messages;
  assert.equal(await ownMessage(db, "alice", aliciaMail.id), null);
  assert.equal(await download(db, "alice", aliciaMail), null);
});

test("a foreign-domain address never makes a message visible", async () => {
  const db = openD1();
  const result = await ingest(db, build({ to: "alice@example.com" }), { to: ["alice@example.com"] }, DOMAIN);
  assert.equal(result.stored, false);
  assert.equal((await listFor(db, "alice", DOMAIN)).messages.length, 0);
});

test("an envelope-only recipient sees the message and the Bcc header is scrubbed from their raw", async () => {
  const db = openD1();
  const raw = build({ to: "alice@booth.pp.ua", extra: ["Bcc: bob@booth.pp.ua", "Received: from relay for <bob@booth.pp.ua>; Fri"], size: 3000 });
  await ingest(db, raw, { to: ["bob@booth.pp.ua"] }, DOMAIN);
  assert.equal((await listFor(db, "bob", DOMAIN)).messages.length, 1);
  const [mail] = (await listFor(db, "bob", DOMAIN)).messages;
  const bobRaw = Buffer.from(await download(db, "bob", mail)).toString("latin1");
  assert.ok(!/^Bcc:/im.test(bobRaw));
  assert.ok(bobRaw.includes("for <bob@booth.pp.ua>"));
  const aliceView = await ingest(db, raw, { to: ["alice@booth.pp.ua"] }, DOMAIN);
  assert.equal(aliceView.duplicate, true);
  const aliceRaw = Buffer.from(await download(db, "alice", mail)).toString("latin1");
  assert.ok(!aliceRaw.includes("for <bob@booth.pp.ua>"));
});

test("hide and read are per name", async () => {
  const db = openD1();
  const raw = build({ to: "alice@booth.pp.ua, alice+x@booth.pp.ua" });
  await ingest(db, raw, { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const [mail] = (await listFor(db, "alice", DOMAIN)).messages;
  assert.equal(mail.read, false);
  await markRead(db, "alice", mail.id);
  assert.equal((await listFor(db, "alice", DOMAIN)).messages[0].read, true);
  assert.equal((await listFor(db, "alice+x", DOMAIN)).messages[0].read, false);
  await hide(db, "alice", mail.id);
  assert.equal((await listFor(db, "alice", DOMAIN)).messages.length, 0);
  assert.equal((await listFor(db, "alice+x", DOMAIN)).messages.length, 1);
});

test("a list past 200 messages is reported as truncated", async () => {
  const db = openD1();
  for (let i = 0; i < 202; i += 1) await ingest(db, build({ size: 600 }), { to: ["many@booth.pp.ua"] }, DOMAIN);
  const found = await listFor(db, "many", DOMAIN);
  assert.equal(found.messages.length, 200);
  assert.equal(found.truncated, true);
});

test("a failed chunk write leaves no index row and the janitor removes the stray chunks", async () => {
  const db = openD1();
  const raw = build({ size: 8_000_000 });
  const real = db.batch;
  let calls = 0;
  db.batch = async (statements) => {
    calls += 1;
    if (calls === 2) throw new Error("injected");
    return real(statements);
  };
  await assert.rejects(ingest(db, raw, { to: ["cloudcheck@booth.pp.ua"] }, DOMAIN), /injected/);
  db.batch = real;
  assert.equal((await listFor(db, "cloudcheck", DOMAIN)).messages.length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM chunks").first("n") > 0);
  db.raw.exec("UPDATE chunks SET created = created - 7200");
  const report = await janitor(db, { storedBytesCap: 1e9, sessionSeconds: 1000 });
  assert.ok(report.orphanChunks > 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").first("n"), 0);
  await ingest(db, raw, { to: ["cloudcheck@booth.pp.ua"] }, DOMAIN);
  const [mail] = (await listFor(db, "cloudcheck", DOMAIN)).messages;
  assert.equal(sha(await download(db, "cloudcheck", mail)), sha(raw));
});

test("the janitor deletes the oldest whole messages until raw bytes fit the cap", async () => {
  const db = openD1();
  for (let i = 0; i < 5; i += 1) {
    await ingest(db, build({ to: "cap@booth.pp.ua", size: 1000, subject: `m${i}` }), { to: ["cap@booth.pp.ua"] }, DOMAIN);
    db.raw.exec(`UPDATE messages SET created = created - ${(5 - i) * 100} WHERE subject = 'm${i}'`);
  }
  const report = await janitor(db, { storedBytesCap: 2800, sessionSeconds: 1000 });
  assert.equal(report.deleted, 3);
  const left = (await listFor(db, "cap", DOMAIN)).messages.map((m) => m.subject).sort();
  assert.deepEqual(left, ["m3", "m4"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").first("n"), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recipients").first("n"), 2);
});

test("an explicit past createdAt becomes the list time and the default stays the ingest time", async () => {
  const db = openD1();
  const before = Math.floor(Date.now() / 1000);
  const past = "2026-10-17T05:12:33.250+07:00";
  await ingest(db, build({ to: "stamp@booth.pp.ua", subject: "imported" }), { to: ["stamp@booth.pp.ua"] }, DOMAIN, { createdAt: past });
  await ingest(db, build({ to: "stamp@booth.pp.ua", subject: "live" }), { to: ["stamp@booth.pp.ua"] }, DOMAIN);
  const bySubject = Object.fromEntries((await listFor(db, "stamp", DOMAIN)).messages.map((m) => [m.subject, m.created]));
  assert.equal(bySubject.imported, new Date(past).toISOString().replace(".250Z", ".000Z"));
  assert.ok(Date.parse(bySubject.live) / 1000 >= before);
});

test("chunks keep the ingest time so the orphan sweep cannot take an import in flight", async () => {
  const db = openD1();
  const before = Math.floor(Date.now() / 1000);
  await ingest(db, build({ to: "stamp@booth.pp.ua" }), { to: ["stamp@booth.pp.ua"] }, DOMAIN, { createdAt: "2026-01-01T00:00:00Z" });
  assert.ok(db.prepare("SELECT MIN(created) AS c FROM chunks").first("c") >= before);
});

test("a duplicate import keeps the stored time", async () => {
  const db = openD1();
  const raw = build({ to: "stamp@booth.pp.ua" });
  await ingest(db, raw, { to: ["stamp@booth.pp.ua"] }, DOMAIN, { createdAt: "2026-10-01T00:00:00Z" });
  const again = await ingest(db, raw, { to: ["stamp@booth.pp.ua"] }, DOMAIN, { createdAt: "2026-10-02T00:00:00Z" });
  assert.equal(again.duplicate, true);
  assert.equal((await listFor(db, "stamp", DOMAIN)).messages[0].created, "2026-10-01T00:00:00.000Z");
});

test("createdAt is honoured only when it parses and is not in the future beyond the skew", () => {
  const at = 1_800_000_000;
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  assert.equal(resolveCreated(iso(at - 86_400), at), at - 86_400);
  assert.equal(resolveCreated(iso(at + 299), at), at + 299);
  assert.equal(resolveCreated(iso(at + 301), at), at);
  assert.equal(resolveCreated(iso(at + 86_400), at), at);
  for (const bad of [undefined, null, "", "yesterday", "1", 1_700_000_000, {}, "2026-13-45T99:99:99Z", "1969-12-31T00:00:00Z"]) assert.equal(resolveCreated(bad, at), at, String(bad));
});

test("since: an idle poll returns nothing and the cursor, a new mail appears once", async () => {
  const db = openD1();
  await ingest(db, build({ to: "alice@booth.pp.ua", subject: "first" }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const full = await listFor(db, "alice", DOMAIN);
  assert.equal(full.incremental, false);
  assert.ok(full.cursor > 0);
  const idle = await listFor(db, "alice", DOMAIN, full.cursor);
  assert.deepEqual([idle.messages, idle.cursor, idle.incremental], [[], full.cursor, true]);
  await ingest(db, build({ to: "alice+x@booth.pp.ua", subject: "second" }), { to: ["alice+x@booth.pp.ua"] }, DOMAIN);
  const next = await listFor(db, "alice", DOMAIN, full.cursor);
  assert.deepEqual(next.messages.map((m) => m.subject), ["second"]);
  assert.ok(next.cursor > full.cursor);
  assert.deepEqual((await listFor(db, "alice", DOMAIN, next.cursor)).messages, []);
  assert.equal((await listFor(db, "alice", DOMAIN, 0)).messages.length, 2);
});

test("since: another name's new mail never appears, but the cursor still moves", async () => {
  const db = openD1();
  await ingest(db, build({ to: "alice@booth.pp.ua" }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const { cursor } = await listFor(db, "alice", DOMAIN);
  await ingest(db, build({ to: "bob@booth.pp.ua", subject: "for bob" }), { to: ["bob@booth.pp.ua"] }, DOMAIN);
  await ingest(db, build({ to: "alicia@booth.pp.ua", subject: "for alicia" }), { to: ["alicia@booth.pp.ua"] }, DOMAIN);
  await ingest(db, build({ to: "alice-b@booth.pp.ua", subject: "for alice-b" }), { to: ["alice-b@booth.pp.ua"] }, DOMAIN);
  const polled = await listFor(db, "alice", DOMAIN, cursor);
  assert.deepEqual(polled.messages, []);
  assert.ok(polled.cursor > cursor);
  assert.deepEqual((await listFor(db, "bob", DOMAIN, cursor)).messages.map((m) => m.subject), ["for bob"]);
  assert.deepEqual((await listFor(db, "alice+x", DOMAIN, cursor)).messages, []);
});

test("since: hidden mail stays hidden and read state is carried", async () => {
  const db = openD1();
  await ingest(db, build({ to: "alice@booth.pp.ua" }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const { cursor } = await listFor(db, "alice", DOMAIN);
  await ingest(db, build({ to: "alice@booth.pp.ua, alice+y@booth.pp.ua", subject: "kept" }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  await ingest(db, build({ to: "alice@booth.pp.ua", subject: "dropped" }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const both = (await listFor(db, "alice", DOMAIN, cursor)).messages;
  assert.equal(both.length, 2);
  const dropped = both.find((m) => m.subject === "dropped");
  const kept = both.find((m) => m.subject === "kept");
  await hide(db, "alice", dropped.id);
  await markRead(db, "alice", kept.id);
  const polled = (await listFor(db, "alice", DOMAIN, cursor)).messages;
  assert.deepEqual(polled.map((m) => [m.subject, m.read]), [["kept", true]]);
  assert.deepEqual((await listFor(db, "alice+y", DOMAIN, cursor)).messages.map((m) => [m.subject, m.read]), [["kept", false]]);
});

test("since: the incremental list matches the full list for the same rows", async () => {
  const db = openD1();
  for (let i = 0; i < 5; i += 1) await ingest(db, build({ to: "alice@booth.pp.ua", subject: `m${i}` }), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const full = await listFor(db, "alice", DOMAIN);
  const since = await listFor(db, "alice", DOMAIN, 0);
  const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(byId(since.messages), byId(full.messages));
});

test("an empty table has cursor 0 and an empty since poll", async () => {
  const db = openD1();
  const full = await listFor(db, "alice", DOMAIN);
  assert.equal(full.cursor, 0);
  assert.deepEqual((await listFor(db, "alice", DOMAIN, 0)).messages, []);
});

test("ingest stores a multipart snippet and none for a mail of 1 MB or more", async () => {
  const db = openD1();
  const part = (body) => `From: a@example.com\r\nTo: alice@booth.pp.ua\r\nSubject: s\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${body}\r\n--b--\r\n`;
  await ingest(db, new TextEncoder().encode(part("caf=C3=A9 ready")), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  await ingest(db, new TextEncoder().encode(part("big mail ".repeat(130_000))), { to: ["alice@booth.pp.ua"] }, DOMAIN);
  const bySize = (await listFor(db, "alice", DOMAIN)).messages.sort((a, b) => a.size - b.size);
  assert.equal(bySize[0].snippet, "café ready");
  assert.ok(bySize[1].size >= 1_048_576);
  assert.equal(bySize[1].snippet, "");
});
