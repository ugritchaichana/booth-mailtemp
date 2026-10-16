import test from "node:test";
import assert from "node:assert/strict";
import { runMonitor, formatDuration } from "../src/monitor.js";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-10-16T00:00:00Z");
const HEALTHY = { mailpit: "ok", bridge: "ok", uptime: 5 };

function kv(initial) {
  const store = new Map(initial ? [["state", JSON.stringify(initial)]] : []);
  return {
    store,
    writes: 0,
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { this.writes += 1; store.set(key, value); },
  };
}

function setup({ state, status = 200, body = HEALTHY, probeThrows, webhookStatus = 200, webhookThrows, buffered = 0, secret = "https://discord.test/api/webhooks/1/token" } = {}) {
  const calls = { probe: 0, posts: [] };
  const env = {
    ALERT_WEBHOOK_URL: secret,
    MONITOR_STATE: kv(state),
    CAPTURE_FALLBACK: { async list() { return { keys: Array.from({ length: buffered }, (_, i) => ({ name: `k${i}` })), list_complete: true }; } },
  };
  const fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      if (webhookThrows) throw new Error("network");
      calls.posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "m1" }), { status: webhookStatus });
    }
    calls.probe += 1;
    if (probeThrows) throw probeThrows;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { env, calls, run: (now) => runMonitor(env, { fetch, now }) };
}

const saved = (env) => JSON.parse(env.MONITOR_STATE.store.get("state"));

test("a healthy probe with no prior failure sends nothing and writes nothing", async () => {
  const t = setup();
  await t.run(T0);
  assert.equal(t.calls.posts.length, 0);
  assert.equal(t.env.MONITOR_STATE.writes, 0);
});

test("one failed probe records the failure but does not alert", async () => {
  const t = setup({ status: 503 });
  await t.run(T0);
  assert.equal(t.calls.posts.length, 0);
  assert.deepEqual(saved(t.env), { failures: 1, firstFailureAt: T0 });
});

test("the second consecutive failure sends one DOWN with the status link and the reason", async () => {
  const t = setup({ state: { failures: 1, firstFailureAt: T0 }, status: 530 });
  await t.run(T0 + 5 * MINUTE);
  assert.equal(t.calls.posts.length, 1);
  const { content, allowed_mentions } = t.calls.posts[0].body;
  assert.match(content, /DOWN/);
  assert.match(content, /HTTP 530/);
  assert.match(content, /https:\/\/mailpit\.booth\.pp\.ua\//);
  assert.deepEqual(allowed_mentions, { parse: [] });
  assert.deepEqual(saved(t.env), { failures: 2, firstFailureAt: T0, down: true, lastAlertAt: T0 + 5 * MINUTE });
});

test("a healthy probe in between resets the failure count", async () => {
  const t = setup({ state: { failures: 1, firstFailureAt: T0 } });
  await t.run(T0 + 5 * MINUTE);
  assert.equal(t.calls.posts.length, 0);
  assert.deepEqual(saved(t.env), { failures: 0 });
});

test("while down, further failures inside two hours send nothing and write nothing", async () => {
  const state = { failures: 2, firstFailureAt: T0, down: true, lastAlertAt: T0 };
  const t = setup({ state, status: 503 });
  await t.run(T0 + 119 * MINUTE);
  assert.equal(t.calls.posts.length, 0);
  assert.equal(t.env.MONITOR_STATE.writes, 0);
});

test("a still-down reminder is sent at two hours and the spacing restarts from it", async () => {
  const state = { failures: 2, firstFailureAt: T0, down: true, lastAlertAt: T0 };
  const t = setup({ state, status: 503 });
  await t.run(T0 + 2 * HOUR);
  assert.equal(t.calls.posts.length, 1);
  assert.match(t.calls.posts[0].body.content, /still DOWN.{2} after 2h 00m/);
  assert.equal(saved(t.env).lastAlertAt, T0 + 2 * HOUR);
  await t.run(T0 + 2 * HOUR + 5 * MINUTE);
  assert.equal(t.calls.posts.length, 1);
});

test("RECOVERED reports the downtime and the buffered mail count, then clears the state", async () => {
  const state = { failures: 2, firstFailureAt: T0, down: true, lastAlertAt: T0 };
  const t = setup({ state, buffered: 3 });
  await t.run(T0 + 75 * MINUTE);
  assert.equal(t.calls.posts.length, 1);
  const { content } = t.calls.posts[0].body;
  assert.match(content, /RECOVERED/);
  assert.match(content, /1h 15m/);
  assert.match(content, /buffered in KV: 3/);
  assert.deepEqual(saved(t.env), { failures: 0 });
});

test("a 200 whose bridge is not ok counts as a failure and names the component", async () => {
  const t = setup({ body: { mailpit: "ok", bridge: "down" } });
  await t.run(T0);
  assert.deepEqual(saved(t.env), { failures: 1, firstFailureAt: T0 });
});

test("a non-JSON 200 and a thrown fetch both count as failures", async () => {
  const a = setup({ body: "<html>" });
  await a.run(T0);
  assert.equal(saved(a.env).failures, 1);
  const b = setup({ probeThrows: new Error("boom") });
  await b.run(T0);
  assert.equal(saved(b.env).failures, 1);
});

test("a failed DOWN post is not swallowed as sent: the next failed probe retries it", async () => {
  const state = { failures: 1, firstFailureAt: T0 };
  const t = setup({ state, status: 503, webhookStatus: 500 });
  await t.run(T0 + 5 * MINUTE);
  assert.equal(saved(t.env).down, undefined);
  const retry = setup({ state: saved(t.env), status: 503 });
  await retry.run(T0 + 10 * MINUTE);
  assert.equal(retry.calls.posts.length, 1);
  assert.equal(saved(retry.env).down, true);
});

test("a webhook that throws never rejects out of the monitor", async () => {
  const t = setup({ state: { failures: 1, firstFailureAt: T0 }, status: 503, webhookThrows: true });
  await assert.doesNotReject(t.run(T0 + 5 * MINUTE));
});

test("a failed RECOVERED post keeps the down state so it is retried", async () => {
  const state = { failures: 2, firstFailureAt: T0, down: true, lastAlertAt: T0 };
  const t = setup({ state, webhookStatus: 429 });
  await t.run(T0 + 10 * MINUTE);
  assert.equal(saved(t.env).down, true);
});

test("without ALERT_WEBHOOK_URL the monitor does nothing, not even probe", async () => {
  const t = setup({ secret: null, status: 503 });
  await t.run(T0);
  assert.equal(t.calls.probe, 0);
  assert.equal(t.env.MONITOR_STATE.writes, 0);
});

test("STATUS_URL overrides the default probe target", async () => {
  const seen = [];
  const fetch = async (url) => { seen.push(String(url)); return new Response(JSON.stringify(HEALTHY)); };
  const t = setup();
  await runMonitor(t.env, { fetch, now: T0 });
  t.env.STATUS_URL = "https://example.test/x";
  await runMonitor(t.env, { fetch, now: T0 });
  assert.deepEqual(seen, ["https://mailpit.booth.pp.ua/api/status", "https://example.test/x"]);
});

test("formatDuration renders minutes and hours", () => {
  assert.equal(formatDuration(30000), "0m");
  assert.equal(formatDuration(12 * MINUTE), "12m");
  assert.equal(formatDuration(65 * MINUTE), "1h 05m");
});
