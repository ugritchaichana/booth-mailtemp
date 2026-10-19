import test from "node:test";
import assert from "node:assert/strict";
import { runMonitor, formatDuration } from "../src/monitor.js";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-10-16T00:00:00Z");
const TTL_SECONDS = 604800;
const HEALTHY = { d1: "ok", lastIngestAt: "2026-10-16T00:00:00.000Z", lastIngestAgeSeconds: 12 };
const waiting = (ageMs, now = T0) => ({ name: "k", expiration: (now - ageMs) / 1000 + TTL_SECONDS });

function kv(initial) {
  const store = new Map(initial ? [["state", JSON.stringify(initial)]] : []);
  return {
    store,
    writes: 0,
    async get(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    async put(key, value) { this.writes += 1; store.set(key, value); },
  };
}

function setup({ state, status = 200, body = HEALTHY, probeThrows, webhookStatus = 200, webhookThrows, buffered = 0, entries, listThrows, secret = "https://discord.test/api/webhooks/1/token" } = {}) {
  const calls = { probe: 0, posts: [] };
  const env = {
    ALERT_WEBHOOK_URL: secret,
    MONITOR_STATE: kv(state),
    CAPTURE_FALLBACK: { async list() { if (listThrows) throw new Error("kv list down"); return { keys: entries ?? Array.from({ length: buffered }, (_, i) => ({ name: `k${i}` })), list_complete: true }; } },
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
  assert.match(content, /https:\/\/mail\.booth\.pp\.ua\//);
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

test("a 200 whose d1 is not ok counts as a failure and names the component", async () => {
  const t = setup({ body: { d1: "error", lastIngestAt: null, lastIngestAgeSeconds: null } });
  await t.run(T0);
  assert.deepEqual(saved(t.env), { failures: 1, firstFailureAt: T0 });
});

test("the failure reason names every component that is not ok and ignores non-status fields", async () => {
  const t = setup({ state: { failures: 1, firstFailureAt: T0 }, body: { d1: "down", queue: "ok", cache: "error", lastIngestAt: "2026-10-16T00:00:00.000Z", n: 3 } });
  await t.run(T0 + 5 * MINUTE);
  assert.match(t.calls.posts[0].body.content, /Reason: d1=down, cache=error\./);
});

test("the old status shape is still judged by the same rule", async () => {
  const healthy = setup({ body: { mailpit: "ok", bridge: "ok", checkedAt: "2026-10-16T00:00:00.000Z" } });
  await healthy.run(T0);
  assert.equal(healthy.env.MONITOR_STATE.writes, 0);
  const sick = setup({ body: { mailpit: "ok", bridge: "down", checkedAt: "2026-10-16T00:00:00.000Z" } });
  await sick.run(T0);
  assert.equal(saved(sick.env).failures, 1);
});

test("a 200 with no status field, or a JSON that is not an object, counts as a failure", async () => {
  for (const body of [{}, { lastIngestAt: null }, [], "null", "7"]) {
    const t = setup({ body });
    await t.run(T0);
    assert.equal(saved(t.env).failures, 1, JSON.stringify(body));
  }
});

test("a non-200 status page counts as a failure", async () => {
  const t = setup({ status: 502, body: { d1: "ok" } });
  await t.run(T0);
  assert.equal(saved(t.env).failures, 1);
});

test("healthy cloud and the oldest buffered mail exactly 10 minutes old: no failure", async () => {
  const t = setup({ entries: [waiting(10 * MINUTE)] });
  await t.run(T0);
  assert.equal(t.env.MONITOR_STATE.writes, 0);
});

test("healthy cloud but the oldest buffered mail is older than 10 minutes: counts as a failure", async () => {
  const t = setup({ entries: [waiting(2 * MINUTE), waiting(10 * MINUTE + 1000)] });
  await t.run(T0);
  assert.deepEqual(saved(t.env), { failures: 1, firstFailureAt: T0 });
});

test("the second stale-buffer run sends DOWN with the count and the age", async () => {
  const state = { failures: 1, firstFailureAt: T0 - 5 * MINUTE };
  const t = setup({ state, entries: [waiting(12 * MINUTE), waiting(3 * MINUTE), waiting(1 * MINUTE)] });
  await t.run(T0);
  assert.equal(t.calls.posts.length, 1);
  const { content } = t.calls.posts[0].body;
  assert.match(content, /DOWN/);
  assert.match(content, /not reaching the cloud: 3 waiting in KV, oldest 12m/);
});

test("an unhealthy status page and a stale buffer are both named in one reason", async () => {
  const state = { failures: 1, firstFailureAt: T0 - 5 * MINUTE };
  const t = setup({ state, status: 503, entries: [waiting(30 * MINUTE)] });
  await t.run(T0);
  assert.match(t.calls.posts[0].body.content, /HTTP 503; mail is not reaching the cloud: 1 waiting in KV, oldest 30m/);
});

test("fresh buffered mail alone never alerts, and entries without an expiration are ignored", async () => {
  const t = setup({ entries: [waiting(4 * MINUTE), { name: "no-expiry" }] });
  await t.run(T0);
  assert.equal(t.env.MONITOR_STATE.writes, 0);
});

test("a KV list that throws does not fail the probe", async () => {
  const t = setup({ listThrows: true });
  await t.run(T0);
  assert.equal(t.env.MONITOR_STATE.writes, 0);
});

test("RECOVERED waits for the buffer to drain, then reports it", async () => {
  const state = { failures: 2, firstFailureAt: T0 - 30 * MINUTE, down: true, lastAlertAt: T0 - 30 * MINUTE };
  const stale = setup({ state, entries: [waiting(15 * MINUTE)] });
  await stale.run(T0);
  assert.equal(stale.calls.posts.length, 0);
  const drained = setup({ state, entries: [] });
  await drained.run(T0 + 5 * MINUTE);
  assert.equal(drained.calls.posts.length, 1);
  assert.match(drained.calls.posts[0].body.content, /RECOVERED/);
  assert.match(drained.calls.posts[0].body.content, /buffered in KV: 0/);
  assert.deepEqual(saved(drained.env), { failures: 0 });
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
  assert.deepEqual(seen, ["https://mail.booth.pp.ua/api/status", "https://example.test/x"]);
});

test("formatDuration renders minutes and hours", () => {
  assert.equal(formatDuration(30000), "0m");
  assert.equal(formatDuration(12 * MINUTE), "12m");
  assert.equal(formatDuration(65 * MINUTE), "1h 05m");
});
