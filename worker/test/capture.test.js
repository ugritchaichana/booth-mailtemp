import test, { mock } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const RAW = new TextEncoder().encode("From: a@example.com\r\nTo: qa@booth.pp.ua\r\nSubject: hi\r\n\r\nbody\r\n");
const FROM = "sender@example.com";
const TO = "qa+tag@booth.pp.ua";
const stream = (bytes) => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const events = (logs) => logs.map((l) => l.event);

async function capture(fn) {
  const realLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    return { logs, outcome: await fn().then((value) => ({ value }), (error) => ({ error })) };
  } finally {
    console.log = realLog;
  }
}

function kvStore({ putThrows = false, entries = [] } = {}) {
  const stored = new Map(entries.map((e) => [e.name, e]));
  return {
    stored,
    puts: [],
    deleted: [],
    async put(key, value, opts) { if (putThrows) throw new Error("kv down"); this.puts.push({ key, value, opts }); stored.set(key, { name: key, value, metadata: opts.metadata }); },
    async list() { return { keys: [...stored.keys()].map((name) => ({ name })), list_complete: true }; },
    async getWithMetadata(name) { const e = stored.get(name); return { value: e?.value ?? null, metadata: e?.metadata ?? null }; },
    async delete(name) { this.deleted.push(name); stored.delete(name); },
  };
}

const okCloud = (calls = []) => ({ async ingest(raw, envelope) { calls.push({ raw, envelope }); return { stored: true, duplicate: false, id: "abc123", size: raw.byteLength }; } });

const receive = (env) => capture(() => worker.email({ from: FROM, to: TO, raw: stream(RAW) }, env));

test("ingest ok: delivered once with the same bytes and envelope, nothing in KV", async () => {
  const calls = [];
  const kv = kvStore();
  const { outcome, logs } = await receive({ CLOUD: okCloud(calls), CAPTURE_FALLBACK: kv, LAST_RESORT: "rethrow" });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(new Uint8Array(calls[0].raw), RAW);
  assert.deepEqual(calls[0].envelope, { from: FROM, to: [TO] });
  assert.equal(kv.puts.length, 0);
  assert.deepEqual(events(logs), ["CAPTURE_DELIVERED"]);
  assert.equal(logs[0].size, RAW.byteLength);
  assert.equal(logs[0].target, "cloud");
  assert.equal(logs[0].from, undefined);
});

test("ingest ok: never calls the network", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return new Response(null, { status: 202 }); };
  try {
    await receive({ CLOUD: okCloud(), CAPTURE_FALLBACK: kvStore() });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
});

test("ingest throws: the mail is stored in KV with its envelope and the email resolves", async () => {
  const kv = kvStore();
  const cloud = { async ingest() { throw new Error("D1_ERROR: boom"); } };
  const { outcome, logs } = await receive({ CLOUD: cloud, CAPTURE_FALLBACK: kv, LAST_RESORT: "rethrow" });
  assert.equal(outcome.error, undefined);
  assert.equal(kv.puts.length, 1);
  assert.deepEqual(new Uint8Array(kv.puts[0].value), RAW);
  assert.deepEqual(kv.puts[0].opts.metadata, { from: FROM, to: TO, size: RAW.byteLength });
  assert.equal(kv.puts[0].opts.expirationTtl, 604800);
  assert.deepEqual(events(logs), ["CAPTURE_FALLBACK"]);
  assert.match(logs[0].reason, /boom/);
  assert.ok(!JSON.stringify(logs[0]).includes("example.com"));
});

test("ingest throws synchronously: same KV fallback", async () => {
  const kv = kvStore();
  const { outcome } = await receive({ CLOUD: { ingest() { throw new Error("sync boom"); } }, CAPTURE_FALLBACK: kv });
  assert.equal(outcome.error, undefined);
  assert.equal(kv.puts.length, 1);
});

test("CLOUD binding missing: the mail goes to KV, not lost", async () => {
  const kv = kvStore();
  const { outcome, logs } = await receive({ CAPTURE_FALLBACK: kv });
  assert.equal(outcome.error, undefined);
  assert.equal(kv.puts.length, 1);
  assert.deepEqual(events(logs), ["CAPTURE_FALLBACK"]);
});

test("ingest never settles: after 15 s the mail goes to KV", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const kv = kvStore();
    const pending = receive({ CLOUD: { ingest() { return new Promise(() => {}); } }, CAPTURE_FALLBACK: kv });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    mock.timers.tick(15000);
    const { outcome, logs } = await pending;
    assert.equal(outcome.error, undefined);
    assert.equal(kv.puts.length, 1);
    assert.match(logs[0].reason, /ingest timeout/);
  } finally {
    mock.timers.reset();
  }
});

test("ingest and KV both fail with LAST_RESORT=rethrow: the email rejects so the sender retries", async () => {
  const cloud = { async ingest() { throw new Error("D1 down"); } };
  const { outcome, logs } = await receive({ CLOUD: cloud, CAPTURE_FALLBACK: kvStore({ putThrows: true }), LAST_RESORT: "rethrow" });
  assert.equal(String(outcome.error), "Error: kv down");
  assert.ok(!events(logs).includes("CAPTURE_DROPPED"));
});

test("ingest and KV both fail without rethrow: CAPTURE_DROPPED is logged and the email resolves", async () => {
  const cloud = { async ingest() { throw new Error("D1 down"); } };
  const { outcome, logs } = await receive({ CLOUD: cloud, CAPTURE_FALLBACK: kvStore({ putThrows: true }) });
  assert.equal(outcome.error, undefined);
  assert.ok(events(logs).includes("CAPTURE_DROPPED"));
});

test("unreadable message body: logged, nothing ingested, nothing stored", async () => {
  const calls = [];
  const kv = kvStore();
  const raw = new ReadableStream({ start(c) { c.error(new Error("stream broke")); } });
  const { outcome, logs } = await capture(() => worker.email({ from: FROM, to: TO, raw }, { CLOUD: okCloud(calls), CAPTURE_FALLBACK: kv }));
  assert.equal(outcome.error, undefined);
  assert.equal(calls.length, 0);
  assert.equal(kv.puts.length, 0);
  assert.equal(logs[0].stage, "buffer");
});

test("ingest answers stored:false: logged as not stored, no KV retry loop", async () => {
  const kv = kvStore();
  const cloud = { async ingest() { return { stored: false, reason: "no recipient on this domain", id: "x" }; } };
  const { logs } = await receive({ CLOUD: cloud, CAPTURE_FALLBACK: kv });
  assert.equal(kv.puts.length, 0);
  assert.deepEqual(events(logs), ["CAPTURE_NOT_STORED"]);
});

function replay({ cloud, entries }) {
  const kv = kvStore({ entries });
  const waiting = [];
  const env = { CLOUD: cloud, CAPTURE_FALLBACK: kv, MONITOR_STATE: { async get() { return null; }, async put() {} } };
  return capture(async () => {
    await worker.scheduled({}, env, { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
  }).then((r) => ({ ...r, kv }));
}

const entry = (name) => ({ name, value: RAW.buffer.slice(0), metadata: { from: FROM, to: TO, size: RAW.byteLength } });

test("replay: a buffered mail is ingested into the cloud, then deleted", async () => {
  const calls = [];
  const { kv, logs } = await replay({ cloud: okCloud(calls), entries: [entry("c1")] });
  assert.equal(calls.length, 1);
  assert.deepEqual(new Uint8Array(calls[0].raw), RAW);
  assert.deepEqual(calls[0].envelope, { from: FROM, to: [TO] });
  assert.deepEqual(kv.deleted, ["c1"]);
  const delivered = logs.find((l) => l.event === "CAPTURE_DELIVERED");
  assert.equal(delivered.replay, true);
  assert.equal(delivered.captureId, "c1");
  assert.equal(delivered.size, RAW.byteLength);
});

test("replay: a failing ingest keeps the entry for the next run and logs the error", async () => {
  const cloud = { async ingest() { throw new Error("D1 down"); } };
  const { kv, logs } = await replay({ cloud, entries: [entry("c1")] });
  assert.deepEqual(kv.deleted, []);
  assert.ok(kv.stored.has("c1"));
  assert.ok(logs.some((l) => l.event === "CAPTURE_ERROR" && l.stage === "replay"));
});

test("replay: one failing entry does not stop the others", async () => {
  let n = 0;
  const cloud = { async ingest() { n += 1; if (n === 1) throw new Error("first fails"); return { stored: true, id: "ok" }; } };
  const { kv } = await replay({ cloud, entries: [entry("c1"), entry("c2")] });
  assert.deepEqual(kv.deleted, ["c2"]);
});

test("replay: an entry that expired between list and get is skipped", async () => {
  const calls = [];
  const { kv } = await replay({ cloud: okCloud(calls), entries: [{ name: "gone", value: null, metadata: null }] });
  assert.equal(calls.length, 0);
  assert.deepEqual(kv.deleted, []);
});

test("replay: a duplicate answer from the cloud still deletes the entry", async () => {
  const cloud = { async ingest() { return { stored: true, duplicate: true, id: "abc123" }; } };
  const { kv } = await replay({ cloud, entries: [entry("c1")] });
  assert.deepEqual(kv.deleted, ["c1"]);
});

test("replay: stored:false deletes the entry so it is not retried until the TTL", async () => {
  const cloud = { async ingest() { return { stored: false, reason: "no recipient on this domain" }; } };
  const { kv, logs } = await replay({ cloud, entries: [entry("c1")] });
  assert.deepEqual(kv.deleted, ["c1"]);
  assert.ok(logs.some((l) => l.event === "CAPTURE_NOT_STORED" && l.replay === true));
});

test("replay: lists at most 15 entries per run", async () => {
  const kv = kvStore({ entries: [entry("c1")] });
  const realList = kv.list;
  let limit;
  kv.list = async (opts) => { limit = opts.limit; return realList.call(kv); };
  const waiting = [];
  await capture(() => worker.scheduled({}, { CLOUD: okCloud(), CAPTURE_FALLBACK: kv }, { waitUntil: (p) => waiting.push(p) }));
  assert.equal(limit, 15);
});
