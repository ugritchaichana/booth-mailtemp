import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("scheduled replays the KV buffer even when the monitor state store is broken", async () => {
  const pushed = [];
  const deleted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    pushed.push(String(url));
    return new Response(null, { status: 202 });
  };
  const waiting = [];
  try {
    const env = {
      HMAC_KEY: "k",
      BRIDGE_URL: "https://bridge.test/ingest",
      ALERT_WEBHOOK_URL: "https://discord.test/api/webhooks/1/t",
      MONITOR_STATE: { async get() { throw new Error("kv down"); } },
      CAPTURE_FALLBACK: {
        async list() { return { keys: [{ name: "c1" }], list_complete: true }; },
        async getWithMetadata() { return { value: new ArrayBuffer(4), metadata: { from: "a", to: "b", size: 4 } }; },
        async delete(name) { deleted.push(name); },
      },
    };
    await worker.scheduled({}, env, { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(pushed, ["https://bridge.test/ingest"]);
  assert.deepEqual(deleted, ["c1"]);
});
