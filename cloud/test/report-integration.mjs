import assert from "node:assert/strict";
import { TURNSTILE_TEST, call, png, reportForm, withReportDev } from "./report-helpers.mjs";
import { startDev } from "./dev-server.mjs";
import { createFakeGithub } from "./fake-github.mjs";

const port = Number(process.env.PORT ?? 8797);
const IMAGES_BYTES = 1_500_000;

async function guardedChecks() {
  const github = createFakeGithub();
  await withReportDev({ port, github }, async (dev) => {
    const { base } = dev;
    assert.deepEqual(await (await call(base, "/api/config")).json(), { turnstileSiteKey: TURNSTILE_TEST.siteKey, reports: true });

    for (const [name, res] of [["random", await call(base, "/api/random")], ["open", await call(base, "/api/open", { method: "POST", body: { username: "needs-token" } })], ["report", await call(base, "/api/report", { method: "POST", body: reportForm([]) })]]) {
      assert.equal(res.status, 403, `${name} without a token`);
      assert.deepEqual(await res.json(), { error: "bot check failed" });
    }
    assert.equal(github.requests.length, 0);

    assert.match((await (await call(base, "/api/random", { token: TURNSTILE_TEST.token })).json()).username, /^rand-[a-z0-9]{6}$/);
    const opened = await call(base, "/api/open", { method: "POST", token: TURNSTILE_TEST.token, body: { username: "turnstile-user" } });
    assert.equal(opened.status, 200, await opened.clone().text());
    assert.equal((await opened.json()).address, "turnstile-user@booth.pp.ua");
    const cookie = opened.headers.get("set-cookie").split(";")[0];
    assert.equal((await call(base, "/api/me", { headers: { Cookie: cookie } })).status, 200, "reading the inbox needs no token");
    console.log("turnstile: open and random refuse a missing token and accept the Cloudflare test token over real siteverify");

    const three = [png(10), png(2000), png(30000)];
    const filed = await call(base, "/api/report", { method: "POST", token: TURNSTILE_TEST.token, body: reportForm(three, { from: "2026-10-19T14:30:00.000Z", route: "#/", details: "cc @octocat" }), headers: { Cookie: cookie } });
    assert.equal(filed.status, 200, await filed.clone().text());
    assert.deepEqual(await filed.json(), { number: 1 });
    const { repo } = github;
    const files = repo.trees.get(repo.commits.get(repo.head).tree);
    assert.equal(files.size, 3);
    [...files.values()].forEach((sha, i) => assert.ok(repo.blobs.get(sha).equals(three[i]), `image ${i + 1} bytes survive the Worker`));
    const [issue] = repo.issues;
    assert.match(issue.body, /- Address: `turnstile-user@booth\.pp\.ua`/);
    assert.ok(issue.body.includes(`cc @${String.fromCharCode(0x200b)}octocat`));
    assert.equal(issue.body.match(/!\[image \d\]\(https:\/\/github\.com\/test-owner\/test-reports\/blob\/[0-9a-f]{40}\/reports\//g).length, 3);
    console.log("report: 3 images committed and 1 issue filed through the fake GitHub, bytes identical, address from the session");

    const big = Array.from({ length: 20 }, (_, i) => png(IMAGES_BYTES + i));
    const started = Date.now();
    const full = await call(base, "/api/report", { method: "POST", token: TURNSTILE_TEST.token, body: reportForm(big), headers: { "X-Forwarded-For": "198.51.100.5" } });
    const wallMs = Date.now() - started;
    assert.equal(full.status, 200, await full.clone().text());
    assert.equal((await full.json()).number, 2);
    const greatest = repo.trees.get(repo.commits.get(repo.head).tree);
    assert.equal(greatest.size, 23);
    const githubCalls = github.requests.filter((r) => r.path.startsWith("/repos/"));
    console.log(`report: 20 images of ${(IMAGES_BYTES / 1e6).toFixed(1)} MB (${(big.reduce((n, b) => n + b.length, 0) / 1e6).toFixed(1)} MB) accepted, wallMs=${wallMs}, github calls in the two reports=${githubCalls.length}`);

    assert.equal((await call(base, "/api/report", { method: "POST", token: TURNSTILE_TEST.token, body: reportForm(big.slice(0, 20).concat([png()])) })).status, 400, "21 images refused");
    for (const secret of [TURNSTILE_TEST.passSecret, github.issuesToken, TURNSTILE_TEST.token, "integration report"]) assert.ok(!dev.log().includes(secret), `dev log leaked ${secret}`);
  });

  const failing = createFakeGithub();
  await withReportDev({ port, github: failing, secret: TURNSTILE_TEST.failSecret }, async ({ base }) => {
    for (const res of [await call(base, "/api/open", { method: "POST", token: TURNSTILE_TEST.token, body: { username: "never-opens" } }), await call(base, "/api/report", { method: "POST", token: TURNSTILE_TEST.token, body: reportForm([]) }), await call(base, "/api/random", { token: TURNSTILE_TEST.token })]) {
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "bot check failed" });
    }
    assert.equal(failing.requests.length, 0);
    console.log("turnstile: the always-fail test secret turns away open, random and report");
  });
}

async function unconfiguredChecks() {
  const github = createFakeGithub();
  await withReportDev({ port, github, secret: "", siteKey: "" }, async ({ base }) => {
    assert.deepEqual(await (await call(base, "/api/config")).json(), { turnstileSiteKey: null, reports: true });
    assert.equal((await call(base, "/api/open", { method: "POST", body: { username: "no-widget-user" } })).status, 200);
    assert.equal((await call(base, "/api/random")).status, 200);
    assert.equal((await call(base, "/api/report", { method: "POST", body: reportForm([png()]) })).status, 200, "report works without Turnstile when only the repository is configured");
    console.log("turnstile unset: address creation and reports work as before");
  });
  const off = createFakeGithub();
  const offPort = await off.listen();
  const dev = await startDev({ port, vars: { GITHUB_API_BASE: `http://127.0.0.1:${offPort}` } });
  try {
    assert.deepEqual(await (await call(dev.base, "/api/config")).json(), { turnstileSiteKey: null, reports: false });
    const res = await call(dev.base, "/api/report", { method: "POST", body: reportForm([]) });
    assert.equal(res.status, 503);
    assert.equal(off.requests.length, 0);
    console.log("report config unset: /api/config says reports=false and /api/report answers 503");
  } finally {
    await dev.stop();
    await off.close();
  }
}

await guardedChecks();
await unconfiguredChecks();
console.log("report integration: all checks passed");
process.exit(0);
