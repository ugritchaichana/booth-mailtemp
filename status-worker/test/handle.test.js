import test from "node:test";
import assert from "node:assert/strict";
import worker, { TARGET_URL } from "../src/index.js";

const call = (path, headers = {}) => worker.fetch(new Request(`https://mailpit.booth.pp.ua${path}`, { headers }));

for (const path of ["/", "/index.html"]) {
  test(`${path} serves the moved notice with 200`, async () => {
    const response = await call(path);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /^text\/html/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(html.includes(`href="${TARGET_URL}"`));
    assert.ok(html.includes("ระบบย้ายไปที่ mail.booth.pp.ua แล้ว"));
    assert.match(html, /<meta name="robots" content="noindex">/);
  });
}

for (const path of ["/some/deep/path", "/admin/", "/index.htm"]) {
  test(`${path} serves the notice with 410`, async () => {
    const response = await call(path);
    assert.equal(response.status, 410);
    assert.match(response.headers.get("Content-Type"), /^text\/html/);
    assert.ok((await response.text()).includes(TARGET_URL));
  });
}

for (const path of ["/api/status", "/admin/api/v1/messages"]) {
  test(`${path} answers 410 JSON`, async () => {
    const response = await call(path);
    assert.equal(response.status, 410);
    assert.match(response.headers.get("Content-Type"), /^application\/json/);
    assert.deepEqual(await response.json(), { error: "moved", to: TARGET_URL });
  });
}

test("Accept: application/json gets JSON on a page path", async () => {
  const response = await call("/", { Accept: "application/json" });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: "moved", to: TARGET_URL });
});

test("a browser Accept header gets HTML", async () => {
  const response = await call("/", { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
});

test("the page makes no external request and links only to the new inbox", async () => {
  const html = await (await call("/")).text();
  const urls = html.match(/(?:https?:)?\/\/[^\s"'<>)]+/g) ?? [];
  assert.deepEqual(urls.filter((u) => !u.startsWith("https://mail.booth.pp.ua/")), []);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b/i);
  assert.doesNotMatch(html, /@import|url\(/i);
});

test("the page has light and dark colours and a viewport meta", async () => {
  const html = await (await call("/")).text();
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /name="viewport"/);
});

test("the notice never calls the origin", async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response("origin"); };
  try {
    for (const path of ["/", "/admin/", "/api/status"]) await call(path);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(called, 0);
});

test("wrangler.toml has the single wildcard route on the old host", async () => {
  const { readFile } = await import("node:fs/promises");
  const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.deepEqual([...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]), ["mailpit.booth.pp.ua/*"]);
  assert.match(toml, /zone_name = "booth\.pp\.ua"/);
});
