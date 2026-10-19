import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("scheduled replays the KV buffer into the cloud even when the monitor state store is broken", async () => {
  const ingested = [];
  const deleted = [];
  const waiting = [];
  const env = {
    CLOUD: { async ingest(raw, envelope) { ingested.push(envelope); return { stored: true, id: "x" }; } },
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
  assert.deepEqual(ingested, [{ from: "a", to: ["b"] }]);
  assert.deepEqual(deleted, ["c1"]);
});
