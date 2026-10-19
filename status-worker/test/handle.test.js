import test from "node:test";
import assert from "node:assert/strict";
import worker, { handle, TARGET_URL } from "../src/index.js";

const request = (path) => new Request(`https://mailpit.booth.pp.ua${path}`);

for (const path of ["/", "/index.html", "/?x=1", "/api/status", "/admin/"]) {
  test(`${path} redirects to the cloud inbox`, async () => {
    const response = await worker.fetch(request(path));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "https://mail.booth.pp.ua/");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "");
  });
}

test("the redirect does not call the origin", async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response("origin"); };
  try {
    await worker.fetch(request("/"));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(called, 0);
});

test("the redirect target is the cloud inbox root", () => {
  assert.equal(new URL(TARGET_URL).origin, "https://mail.booth.pp.ua");
  assert.equal(handle().headers.get("Location"), TARGET_URL);
});

test("routes in wrangler.toml cover only the page paths", async () => {
  const { readFile } = await import("node:fs/promises");
  const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  const patterns = [...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(patterns, ["mailpit.booth.pp.ua/", "mailpit.booth.pp.ua/index.html"]);
});
