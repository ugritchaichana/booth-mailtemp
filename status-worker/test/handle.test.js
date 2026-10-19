import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker, { TARGET_URL } from "../src/index.js";

const call = (path, headers = {}) => worker.fetch(new Request(`https://mailpit.booth.pp.ua${path}`, { headers }));

for (const path of ["/", "/index.html", "/some/deep/path", "/admin/", "/?x=1"]) {
  test(`${path} serves the notice with 200 and a redirect to the new root`, async () => {
    const response = await call(path);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /^text\/html/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(html.includes("Moved to mail.booth.pp.ua"));
    assert.ok(html.includes('<meta http-equiv="refresh" content="10;url=https://mail.booth.pp.ua/">'));
    assert.match(html, /location\.replace\("https:\/\/mail\.booth\.pp\.ua\/"\)\},10000\)/);
    assert.ok(html.includes(`<a class="go" href="${TARGET_URL}">Go now</a>`));
    assert.match(html, /<meta name="robots" content="noindex">/);
  });
}

for (const path of ["/api/status", "/api/v1/messages", "/admin/api/v1/messages"]) {
  test(`${path} answers 410 JSON`, async () => {
    const response = await call(path);
    assert.equal(response.status, 410);
    assert.match(response.headers.get("Content-Type"), /^application\/json/);
    assert.deepEqual(await response.json(), { error: "moved", to: TARGET_URL });
  });
}

test("Accept: application/json gets 410 JSON on a page path", async () => {
  const response = await call("/", { Accept: "application/json" });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: "moved", to: TARGET_URL });
});

test("a browser Accept header gets HTML", async () => {
  const response = await call("/", { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
});

test("the page makes no external request and links only to the new inbox", async () => {
  const html = await (await call("/")).text();
  const urls = html.match(/(?:https?:)?\/\/[^\s"'<>)]+/g) ?? [];
  assert.deepEqual(urls.filter((u) => !u.startsWith("https://mail.booth.pp.ua/")), []);
  assert.doesNotMatch(html, /<(?:script|img|iframe)[^>]*src=|<link/i);
  assert.doesNotMatch(html, /@import|url\(/i);
});

test("the bar steps by script and no CSS rule forces it full", async () => {
  const html = await (await call("/")).text();
  assert.match(html, /transition:width 1s linear/);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\.bar i\{transition:none\}\}/);
  assert.doesNotMatch(html, /width:100%\}/);
  assert.doesNotMatch(html, /animation/);
});

test("the script counts 10 to 1, widens the bar 10 percent a second and redirects at 10 seconds", async () => {
  const html = await (await call("/")).text();
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const timers = [];
  let now = 0;
  const elements = { n: { textContent: "10" }, b: { style: { width: "" } } };
  const redirects = [];
  const sandbox = {
    document: { getElementById: (id) => elements[id] },
    location: { replace: (url) => redirects.push([now, url]) },
    setTimeout: (fn, ms) => timers.push({ at: now + ms, fn, every: 0 }),
    setInterval: (fn, ms) => timers.push({ at: now + ms, fn, every: ms }),
  };
  vm.runInNewContext(source, sandbox);
  const seen = [];
  while (timers.length) {
    timers.sort((x, y) => x.at - y.at);
    const next = timers[0];
    if (next.at > 12000) break;
    now = next.at;
    if (next.every) next.at += next.every; else timers.shift();
    next.fn();
    seen.push([now, elements.n.textContent, elements.b.style.width]);
  }
  const steps = seen.filter(([, , width], i) => width !== "" && width !== (seen[i - 1]?.[2] ?? ""));
  assert.deepEqual(steps.map(([, text]) => String(text)), ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
  assert.deepEqual(steps.map(([, , width]) => width), ["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"]);
  assert.deepEqual(redirects, [[10000, TARGET_URL]]);
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

test("the page is English only", async () => {
  const html = await (await call("/")).text();
  assert.doesNotMatch(html, /[\u0E00-\u0E7F]/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Moved to mail\.booth\.pp\.ua<\/title>/);
  assert.ok(html.includes('Email addresses are unchanged. Redirecting in <span id="n">10</span> seconds.'));
});
