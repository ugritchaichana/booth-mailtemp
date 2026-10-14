import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";

const page = (path = "/") => new Request(`https://mailpit.booth.pp.ua${path}`);
const origin = (response) => async () => response;

test("a healthy origin response passes through untouched", async () => {
  const upstream = new Response("<html>inbox</html>", { status: 200, headers: { "X-Origin": "yes" } });
  const response = await handle(page("/"), origin(upstream));
  assert.equal(response, upstream);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<html>inbox</html>");
  assert.equal(response.headers.get("X-Origin"), "yes");
});

for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
  test(`origin status ${status} on / serves the fallback page`, async () => {
    const response = await handle(page("/"), origin(new Response("tunnel error", { status })));
    assert.equal(response.status, 503);
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    assert.equal(response.headers.get("Retry-After"), "15");
    const body = await response.text();
    assert.match(body, /System is down/);
    assert.match(body, /Your mail is safe and queued/);
    assert.match(body, /15000/);
  });
}

test("a thrown fetch on / serves the fallback page", async () => {
  const response = await handle(page("/"), async () => { throw new TypeError("network"); });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /System is down/);
});

test("/index.html gets the same protection", async () => {
  const response = await handle(page("/index.html"), origin(new Response("x", { status: 530 })));
  assert.equal(response.status, 503);
});

test("origin 404 and 500 on / are not replaced", async () => {
  for (const status of [404, 500, 401]) {
    const upstream = new Response("origin says no", { status });
    assert.equal(await handle(page("/"), origin(upstream)), upstream);
  }
});

test("a non-root path is passed through even when the origin is down", async () => {
  for (const path of ["/api/status", "/api/messages", "/vendor/app.css", "/admin/"]) {
    const upstream = new Response("tunnel error", { status: 530 });
    const response = await handle(page(path), origin(upstream));
    assert.equal(response, upstream, path);
    assert.equal(response.status, 530);
  }
});

test("a thrown fetch on a non-root path is not swallowed", async () => {
  await assert.rejects(handle(page("/api/status"), async () => { throw new TypeError("network"); }), TypeError);
});

test("the fallback page is self-contained", async () => {
  const body = await (await handle(page("/"), async () => { throw new Error("down"); })).text();
  assert.doesNotMatch(body, /<link /);
  assert.doesNotMatch(body, /<script src=/);
  assert.doesNotMatch(body, /https?:\/\/(?!www\.w3\.org)/);
});
