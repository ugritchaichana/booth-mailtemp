import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const RAW = new TextEncoder().encode("From: a@example.com\r\nTo: qa@booth.pp.ua\r\nSubject: hi\r\n\r\nbody\r\n");
const FROM = "sender@example.com";
const TO = "qa+tag@booth.pp.ua";

const stream = (bytes) => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });

async function run({ bridgeStatus = 202, bridgeThrows = false, cloud, kvPutThrows = false, ctx = "real" } = {}) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logs = [];
  const bridge = [];
  const kv = [];
  const waiting = [];
  console.log = (line) => logs.push(JSON.parse(line));
  globalThis.fetch = async (url, init) => {
    bridge.push({ url: String(url), body: init.body });
    if (bridgeThrows) throw new Error("bridge down");
    return new Response(null, { status: bridgeStatus });
  };
  const env = {
    HMAC_KEY: "k",
    BRIDGE_URL: "https://bridge.test/ingest",
    LAST_RESORT: "rethrow",
    CAPTURE_FALLBACK: { async put(key, value, opts) { if (kvPutThrows) throw new Error("kv down"); kv.push({ key, value, opts }); } },
    ...(cloud ? { CLOUD: cloud } : {}),
  };
  let outcome;
  try {
    const waitUntil = ctx === "real" ? (p) => waiting.push(p) : undefined;
    const message = { from: FROM, to: TO, raw: stream(RAW) };
    outcome = await worker.email(message, env, waitUntil ? { waitUntil } : undefined).then((value) => ({ value }), (error) => ({ error }));
    await Promise.all(waiting);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  return { outcome, logs, bridge, kv, waiting };
}

const events = (logs) => logs.map((l) => l.event);

test("push ok: the cloud receives the same bytes and envelope exactly once", async () => {
  const calls = [];
  const cloud = { async ingest(raw, envelope) { calls.push({ raw, envelope }); return { stored: true, id: "abc123", size: raw.byteLength }; } };
  const { outcome, logs, kv, bridge } = await run({ cloud });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(new Uint8Array(calls[0].raw), RAW);
  assert.deepEqual(calls[0].envelope, { from: FROM, to: [TO] });
  assert.equal(bridge.length, 1);
  assert.equal(kv.length, 0);
  assert.deepEqual(events(logs), ["CAPTURE_DELIVERED", "CLOUD_COPY_OK"]);
  const ok = logs.find((l) => l.event === "CLOUD_COPY_OK");
  assert.equal(ok.size, RAW.byteLength);
  assert.equal(ok.id, "abc123");
  assert.equal(ok.to, undefined);
  assert.equal(ok.from, undefined);
});

test("push ok: the copy reuses the buffer sent to the bridge", async () => {
  let copied;
  const cloud = { async ingest(raw) { copied = raw; return { stored: true, id: "x" }; } };
  const { bridge } = await run({ cloud });
  assert.equal(copied, bridge[0].body);
});

test("push fails with a 5xx: no copy, the mail goes to the KV fallback as before", async () => {
  let called = 0;
  const cloud = { async ingest() { called += 1; } };
  const { outcome, logs, kv } = await run({ bridgeStatus: 503, cloud });
  assert.equal(outcome.error, undefined);
  assert.equal(called, 0);
  assert.equal(kv.length, 1);
  assert.deepEqual(new Uint8Array(kv[0].value), RAW);
  assert.deepEqual(kv[0].opts.metadata, { from: FROM, to: TO, size: RAW.byteLength });
  assert.deepEqual(events(logs), ["CAPTURE_FALLBACK"]);
});

test("push throws: no copy, the KV fallback is unchanged", async () => {
  let called = 0;
  const cloud = { async ingest() { called += 1; } };
  const { logs, kv } = await run({ bridgeThrows: true, cloud });
  assert.equal(called, 0);
  assert.equal(kv.length, 1);
  assert.deepEqual(events(logs), ["CAPTURE_FALLBACK"]);
});

test("push and KV both fail: still rethrows, no copy", async () => {
  let called = 0;
  const cloud = { async ingest() { called += 1; } };
  const { outcome, logs } = await run({ bridgeThrows: true, kvPutThrows: true, cloud });
  assert.equal(String(outcome.error), "Error: kv down");
  assert.equal(called, 0);
  assert.ok(!events(logs).some((e) => e.startsWith("CLOUD_")));
});

test("copy rejects: email resolves as before and CLOUD_COPY_ERROR is logged without addresses", async () => {
  const cloud = { async ingest() { throw new Error("D1_ERROR: boom"); } };
  const { outcome, logs, kv } = await run({ cloud });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value, undefined);
  assert.equal(kv.length, 0);
  assert.deepEqual(events(logs), ["CAPTURE_DELIVERED", "CLOUD_COPY_ERROR"]);
  const err = logs.find((l) => l.event === "CLOUD_COPY_ERROR");
  assert.equal(err.size, RAW.byteLength);
  assert.match(err.error, /boom/);
  assert.ok(!JSON.stringify(err).includes("booth.pp.ua"));
  assert.ok(!JSON.stringify(err).includes("example.com"));
});

test("copy throws synchronously: email still resolves and the error is logged", async () => {
  const cloud = { ingest() { throw new Error("sync boom"); } };
  const { outcome, logs, kv } = await run({ cloud });
  assert.equal(outcome.error, undefined);
  assert.equal(kv.length, 0);
  assert.deepEqual(events(logs), ["CAPTURE_DELIVERED", "CLOUD_COPY_ERROR"]);
});

test("copy never settles within the handler: email does not wait for it", async () => {
  const cloud = { ingest() { return new Promise(() => {}); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 202 });
  const waiting = [];
  try {
    const env = { HMAC_KEY: "k", BRIDGE_URL: "https://bridge.test/ingest", CLOUD: cloud };
    await worker.email({ from: FROM, to: TO, raw: stream(RAW) }, env, { waitUntil: (p) => waiting.push(p) });
    assert.equal(waiting.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("waitUntil throws: email still resolves and nothing falls back to KV", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  globalThis.fetch = async () => new Response(null, { status: 202 });
  const kv = [];
  try {
    const env = {
      HMAC_KEY: "k",
      BRIDGE_URL: "https://bridge.test/ingest",
      CAPTURE_FALLBACK: { async put(key) { kv.push(key); } },
      CLOUD: { async ingest() { return { stored: true, id: "x" }; } },
    };
    await worker.email({ from: FROM, to: TO, raw: stream(RAW) }, env, { waitUntil() { throw new Error("no waitUntil"); } });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(kv.length, 0);
  assert.ok(events(logs).includes("CAPTURE_DELIVERED"));
});

test("binding absent: no copy and no cloud log lines", async () => {
  const { outcome, logs, kv } = await run({});
  assert.equal(outcome.error, undefined);
  assert.equal(kv.length, 0);
  assert.deepEqual(events(logs), ["CAPTURE_DELIVERED"]);
});

test("binding present but no ctx: email still resolves", async () => {
  const cloud = { async ingest() { return { stored: true, id: "x" }; } };
  const { outcome, logs } = await run({ cloud, ctx: "none" });
  assert.equal(outcome.error, undefined);
  assert.ok(events(logs).includes("CAPTURE_DELIVERED"));
});

test("replay (scheduled) never copies to the cloud", async () => {
  let called = 0;
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  globalThis.fetch = async () => new Response(null, { status: 202 });
  const deleted = [];
  const waiting = [];
  try {
    const env = {
      HMAC_KEY: "k",
      BRIDGE_URL: "https://bridge.test/ingest",
      MONITOR_STATE: { async get() { return null; }, async put() {} },
      CLOUD: { async ingest() { called += 1; } },
      CAPTURE_FALLBACK: {
        async list() { return { keys: [{ name: "c1" }], list_complete: true }; },
        async getWithMetadata() { return { value: RAW.buffer.slice(0), metadata: { from: FROM, to: TO, size: RAW.byteLength } }; },
        async delete(name) { deleted.push(name); },
      },
    };
    await worker.scheduled({}, env, { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(called, 0);
  assert.deepEqual(deleted, ["c1"]);
  assert.ok(logs.some((l) => l.event === "CAPTURE_DELIVERED" && l.replay === true));
  assert.ok(!events(logs).some((e) => e.startsWith("CLOUD_")));
});
