import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fake, logged, setup } from "./admin-helpers.mjs";
import { handle } from "../src/api.js";
import { MAX_DETAILS, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TITLE, REPORTS_PER_HOUR, base64, clean, issueBody } from "../src/report.js";

const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SECRET = "turnstile-secret-for-tests";
const TOKEN = "turnstile-token-for-tests";
const ZWSP = String.fromCharCode(0x200b);
const BIDI = String.fromCharCode(0x202e);

const verify = { calls: [], respond: () => ({ success: true, hostname: "mail.test" }) };
const githubFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url.startsWith("http://127.0.0.1:1/")) throw new TypeError("fetch failed");
  if (request.url !== VERIFY) return githubFetch(request);
  verify.calls.push(Object.fromEntries(new URLSearchParams(await request.text())));
  const answer = verify.respond();
  if (answer instanceof Error) throw answer;
  return answer instanceof Response ? answer : Response.json(answer);
};

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const image = (kind = "png", size = 64, name = `shot.${kind}`) => {
  const head = { png: PNG, jpg: Buffer.from("ffd8ffe0", "hex"), gif: Buffer.from("GIF89a"), webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]) }[kind];
  return { bytes: Buffer.concat([head, crypto.randomBytes(Math.max(size - head.length, 0))]), name, type: `image/${kind}` };
};

const reportEnv = (extra = {}) => {
  verify.calls.length = 0;
  verify.respond = () => ({ success: true, hostname: "mail.test" });
  return setup({ ISSUES_REPO: fake.reportsRepo, GITHUB_ISSUES_TOKEN: fake.issuesToken, ...extra });
};
const guarded = (extra = {}) => reportEnv({ TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET: SECRET, ...extra });

function formOf({ category = "bug", title = "Cannot open inbox", details = "The page keeps spinning.", from, to, route, images = [], raw = [] } = {}) {
  const form = new FormData();
  form.append("category", category);
  form.append("title", title);
  form.append("details", details);
  for (const [key, value] of Object.entries({ from, to, route })) if (value !== undefined) form.append(key, value);
  for (const img of images) form.append("images", new Blob([img.bytes], { type: img.type }), img.name);
  for (const value of raw) form.append("images", value);
  return form;
}

const send = (env, form, { ip = "203.0.113.7", token = TOKEN, headers = {} } = {}) => handle(new Request("https://mail.test/api/report", {
  method: "POST",
  headers: { "cf-connecting-ip": ip, ...(token ? { "x-turnstile-token": token } : {}), ...headers },
  body: form,
}), env, {});

const get = (env, path, { token, ip = "203.0.113.7" } = {}) => handle(new Request(`https://mail.test${path}`, { headers: { "cf-connecting-ip": ip, ...(token ? { "x-turnstile-token": token } : {}) } }), env, {});
const open = (env, username, { token, ip = "203.0.113.7", cookie } = {}) => handle(new Request("https://mail.test/api/open", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(token ? { "x-turnstile-token": token } : {}), ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ username }),
}), env, {});

const githubCalls = () => fake.requests.filter((r) => r.path.startsWith("/repos/"));
const countOf = (stage) => githubCalls().filter((r) => stage.test(r.path)).length;
const rows = (env, table) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("with Turnstile unset address creation works as before and /api/config offers no site key", async () => {
  const env = reportEnv();
  assert.deepEqual(await (await get(env, "/api/config")).json(), { turnstileSiteKey: null, reports: true });
  assert.equal((await get(env, "/api/random")).status, 200);
  assert.equal((await open(env, "plain-user")).status, 200);
  assert.equal(verify.calls.length, 0);
  for (const half of [{ TURNSTILE_SITE_KEY: "site-key" }, { TURNSTILE_SECRET: SECRET }]) {
    const one = reportEnv(half);
    assert.equal((await open(one, "half-config")).status, 200, JSON.stringify(Object.keys(half)));
    assert.equal((await (await get(one, "/api/config")).json()).turnstileSiteKey, null);
  }
});

test("/api/config exposes the site key, never the secret, once both are set", async () => {
  const body = await (await get(guarded(), "/api/config")).json();
  assert.deepEqual(body, { turnstileSiteKey: "site-key", reports: true });
});

test("open and random need a valid Turnstile token once configured, and a failed check touches no table", async () => {
  const env = guarded();
  for (const call of [() => get(env, "/api/random"), () => open(env, "needs-token")]) {
    const res = await call();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "bot check failed" });
  }
  assert.equal(verify.calls.length, 0, "a missing token never reaches siteverify");
  assert.equal(rows(env, "users"), 0);
  assert.equal(rows(env, "rate_hits"), 0);

  assert.equal((await get(env, "/api/random", { token: TOKEN })).status, 200);
  assert.equal((await open(env, "has-token", { token: TOKEN })).status, 200);
  assert.deepEqual(verify.calls.map((c) => [c.secret, c.response, c.remoteip]), [[SECRET, TOKEN, "203.0.113.7"], [SECRET, TOKEN, "203.0.113.7"]]);
  assert.equal(rows(env, "users"), 1);
});

test("a rejected, reused, wrong-host or wrong-action token is a 403 and an oversized token is not even sent", async () => {
  const env = guarded();
  const cases = [
    ["failed", { success: false, "error-codes": ["invalid-input-response"] }],
    ["reused", { success: false, "error-codes": ["timeout-or-duplicate"] }],
    ["other host", { success: true, hostname: "evil.example" }],
    ["other action", { success: true, hostname: "mail.test", action: "report" }],
    ["missing success", { hostname: "mail.test" }],
  ];
  for (const [name, answer] of cases) {
    verify.respond = () => answer;
    const res = await open(env, "rejected-name", { token: TOKEN });
    assert.equal(res.status, 403, name);
    assert.deepEqual(await res.json(), { error: "bot check failed" }, name);
  }
  assert.equal(rows(env, "users"), 0);
  verify.calls.length = 0;
  assert.equal((await open(env, "rejected-name", { token: "x".repeat(2049) })).status, 403);
  assert.equal(verify.calls.length, 0);
});

test("the matching action and host pass, an empty action passes, and Cloudflare test-key answers pass on any host", async () => {
  const env = guarded();
  for (const answer of [{ success: true, hostname: "mail.test", action: "open" }, { success: true, hostname: "mail.test", action: "" }, { success: true }, { success: true, hostname: "example.com", metadata: { result_with_testing_key: true } }]) {
    verify.respond = () => answer;
    assert.equal((await open(env, `pass-${crypto.randomBytes(3).toString("hex")}`, { token: TOKEN })).status, 200, JSON.stringify(answer));
  }
  verify.respond = () => ({ success: true, hostname: "mail.test", action: "random" });
  assert.equal((await get(env, "/api/random", { token: TOKEN })).status, 200);
});

test("when siteverify is down or answers an error the request fails closed with 503", async () => {
  const env = guarded();
  for (const answer of [new Error("network"), new Response("oops", { status: 500 }), new Response("not json", { status: 200 })]) {
    verify.respond = () => answer;
    const res = await open(env, "closed-name", { token: TOKEN });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "bot check unavailable, try again" });
  }
  assert.equal(rows(env, "users"), 0);
});

test("an invalid username is refused before a Turnstile token is spent", async () => {
  const env = guarded();
  assert.equal((await open(env, "x", { token: TOKEN })).status, 400);
  assert.equal(verify.calls.length, 0);
});

test("a valid report with three images commits them in one commit and files one labelled issue", async () => {
  const env = guarded();
  const images = [image("png", 300), image("jpg", 500), image("gif", 200)];
  const res = await send(env, formOf({ images, route: "#/view/abc", from: "2026-10-19T14:30:00.000Z", to: "2026-10-19T15:00:00.000Z" }), { headers: { "user-agent": "TestBrowser/1.0" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { number: 1 });
  assert.deepEqual(verify.calls.map((c) => c.response), [TOKEN]);

  const { repo } = fake;
  const [issue] = repo.issues;
  assert.equal(issue.title, "[bug] Cannot open inbox");
  assert.deepEqual(issue.labels, ["report", "report:bug"]);
  const files = repo.trees.get(repo.commits.get(repo.head).tree);
  const paths = [...files.keys()];
  assert.equal(paths.length, 3);
  assert.match(paths[0], /^reports\/\d{4}\/\d{2}\/\d{8}-\d{6}-[0-9a-f]{8}\/1\.png$/);
  assert.deepEqual(paths.map((p) => p.split(".").pop()), ["png", "jpg", "gif"]);
  assert.equal(new Set(paths.map((p) => p.split("/").slice(0, -1).join("/"))).size, 1);
  paths.forEach((p, i) => assert.ok(repo.blobs.get(files.get(p)).equals(images[i].bytes), `image ${i + 1} bytes survive`));
  assert.equal(repo.commits.get(repo.head).parents[0], "1".repeat(40));
  paths.forEach((p, i) => assert.ok(issue.body.includes(`![image ${i + 1}](https://github.com/${fake.reportsRepo}/blob/${repo.head}/${p}?raw=true)`)));
  assert.match(issue.body, /\*\*Category:\*\* bug/);
  assert.match(issue.body, /\*\*When:\*\* 2026-10-19 21:30 Asia\/Bangkok \(2026-10-19 14:30 UTC\) to 2026-10-19 22:00 Asia\/Bangkok \(2026-10-19 15:00 UTC\)/);
  assert.match(issue.body, /### Details\n\nThe page keeps spinning\./);
  assert.match(issue.body, /- Page: `#\/view\/abc`/);
  assert.match(issue.body, /- Browser: `TestBrowser\/1\.0`/);
  assert.match(issue.body, /- Reported: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.doesNotMatch(issue.body, /- Address:/, "no session, no address line");
  assert.deepEqual(githubCalls().map((r) => r.authorization), Array(githubCalls().length).fill(`Bearer ${fake.issuesToken}`));
  assert.deepEqual(["blobs", "trees", "commits"].map((k) => countOf(new RegExp(`/git/${k}$`))), [3, 1, 1]);
});

test("a report without images makes exactly one GitHub call and no commit", async () => {
  const env = reportEnv();
  const res = await send(env, formOf({ details: "plain text only" }), { token: null });
  assert.equal(res.status, 200);
  assert.equal(githubCalls().length, 1);
  assert.equal(fake.repo.head, "1".repeat(40));
  assert.doesNotMatch(fake.repo.issues[0].body, /### Images/);
});

test("twenty images stay within the Workers subrequest limit", async () => {
  const env = guarded();
  const res = await send(env, formOf({ images: Array.from({ length: MAX_IMAGES }, (_, i) => image("png", 2000 + i)) }));
  assert.equal(res.status, 200);
  assert.equal(githubCalls().length, 26);
  assert.ok(githubCalls().length + verify.calls.length <= 50);
  assert.equal(fake.repo.trees.get(fake.repo.commits.get(fake.repo.head).tree).size, MAX_IMAGES);
});

test("the active address of the sender's session appears in the issue context", async () => {
  const env = reportEnv();
  const opened = await open(env, "context-user");
  const cookie = opened.headers.get("set-cookie").split(";")[0];
  assert.equal((await send(env, formOf(), { headers: { cookie } })).status, 200);
  assert.match(fake.repo.issues[0].body, /- Address: `context-user@booth\.pp\.ua`/);
});

test("the image type comes from the magic bytes, never from the filename or declared type", async () => {
  const env = reportEnv();
  const kinds = ["png", "jpg", "gif", "webp"].map((kind) => ({ ...image(kind), name: "all.txt", type: "application/octet-stream" }));
  assert.equal((await send(env, formOf({ images: kinds }), { token: null })).status, 200);
  const files = fake.repo.trees.get(fake.repo.commits.get(fake.repo.head).tree);
  assert.deepEqual([...files.keys()].map((p) => p.split(".").pop()), ["png", "jpg", "gif", "webp"]);
  for (const [name, bytes] of [["svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"], ["html", "<html><script>1</script>"], ["text", "plain text"], ["empty", ""], ["riff but not webp", "RIFF0000WAVE"]]) {
    const before = githubCalls().length;
    const res = await send(env, formOf({ images: [{ bytes: Buffer.from(bytes), name: "fake.png", type: "image/png" }] }), { token: null });
    assert.equal(res.status, 400, name);
    assert.deepEqual(await res.json(), { error: "images must be png, jpeg, webp or gif" }, name);
    assert.equal(githubCalls().length, before, name);
  }
});

test("validation answers 400 or 413 and neither calls GitHub nor uses up the rate limit", async () => {
  const env = reportEnv();
  const stamp = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
  const cases = [
    ["unknown category", formOf({ category: "rant" }), 400, /invalid category/],
    ["no title", formOf({ title: "   " }), 400, /title is required/],
    ["title too long", formOf({ title: "t".repeat(MAX_TITLE + 1) }), 400, /title must be at most 120/],
    ["no details", formOf({ details: "\n " }), 400, /details are required/],
    ["details too long", formOf({ details: "d".repeat(MAX_DETAILS + 1) }), 400, /details must be at most 10000/],
    ["start after end", formOf({ from: "2026-10-19T15:00:00.000Z", to: "2026-10-19T14:00:00.000Z" }), 400, /start time is after/],
    ["time without zone", formOf({ from: "2026-10-19T14:30" }), 400, /invalid time/],
    ["time is not a date", formOf({ to: "yesterday" }), 400, /invalid time/],
    ["time in the far future", formOf({ to: stamp(3 * 86400_000) }), 400, /invalid time/],
    ["too many images", formOf({ images: Array.from({ length: MAX_IMAGES + 1 }, () => image()) }), 400, /at most 20 images/],
    ["one image too big", formOf({ images: [image("png", MAX_IMAGE_BYTES + 1)] }), 413, /each image must be at most 5 MB/],
    ["images too big together", formOf({ images: Array.from({ length: 7 }, () => image("png", MAX_IMAGE_BYTES)) }), 413, /total at most 30 MB/],
    ["an image field that is text", formOf({ raw: ["not a file"] }), 400, /invalid image/],
  ];
  for (const [name, form, status, message] of cases) {
    const res = await send(env, form, { token: null });
    assert.equal(res.status, status, name);
    assert.match((await res.json()).error, message, name);
  }
  assert.equal(githubCalls().length, 0);
  assert.equal(rows(env, "rate_hits"), 0);

  const edge = await send(env, formOf({ title: "t".repeat(MAX_TITLE), details: "d".repeat(MAX_DETAILS), images: [image("png", MAX_IMAGE_BYTES)], from: stamp(-3600_000), to: stamp(3600_000) }), { token: null });
  assert.equal(edge.status, 200, "the exact limits are accepted");
});

test("a request that is not multipart, or declares a huge body, is refused before anything is read", async () => {
  const env = guarded();
  const json = await handle(new Request("https://mail.test/api/report", { method: "POST", headers: { "content-type": "application/json", "x-turnstile-token": TOKEN }, body: "{}" }), env, {});
  assert.equal(json.status, 415);
  const huge = await send(env, formOf(), { headers: { "content-length": String(40 * 1024 * 1024) } });
  assert.equal(huge.status, 413);
  assert.equal(verify.calls.length, 0);
  assert.equal(githubCalls().length, 0);
});

test("every @ becomes @ plus a zero-width space so nothing in the issue can mention anyone", async () => {
  const env = reportEnv();
  const res = await send(env, formOf({ title: "ping @octocat now", details: "cc @octocat and @org/team\nmail me@example.com", route: "#/@octocat" }), { token: null });
  assert.equal(res.status, 200);
  const [issue] = fake.repo.issues;
  assert.equal(issue.title, `[bug] ping @${ZWSP}octocat now`);
  assert.ok(issue.body.includes(`cc @${ZWSP}octocat and @${ZWSP}org/team\nmail me@${ZWSP}example.com`));
  assert.doesNotMatch(`${issue.title}\n${issue.body}`.replaceAll(`@${ZWSP}`, ""), /@/);
});

test("control and direction-override characters are removed while newlines and tabs in details stay", async () => {
  const env = reportEnv();
  const res = await send(env, formOf({ title: `a\nb\u0000c${BIDI}d`, details: `line1\r\nline2\tx\u0007${BIDI}y\u007f`, route: "#/x\ny" }), { token: null });
  assert.equal(res.status, 200);
  const [issue] = fake.repo.issues;
  assert.equal(issue.title, "[bug] a bcd");
  assert.ok(issue.body.includes("line1\nline2\txy"));
  assert.ok(issue.body.includes("- Page: `#/x y`"));
  assert.equal(clean(`x${BIDI}`, true), "x");
});

test("backticks in the page and browser fields cannot break out of their code span", () => {
  const body = issueBody({ report: { category: "bug", details: "d", images: [], from: null, to: null, route: "#/a`b" }, links: [], address: null, agent: "ua`x", reportedAt: 0, version: null });
  assert.ok(body.includes("`#/a'b`") && body.includes("`ua'x`"));
});

test(`the sixth report in an hour from one IP is a 429, other IPs are unaffected, and failures count too`, async () => {
  const env = reportEnv();
  for (let i = 0; i < REPORTS_PER_HOUR; i += 1) assert.equal((await send(env, formOf(), { token: null })).status, 200, `report ${i + 1}`);
  const limited = await send(env, formOf(), { token: null });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Too many reports, try again later" });
  assert.equal(fake.repo.issues.length, REPORTS_PER_HOUR);
  assert.equal((await send(env, formOf(), { token: null, ip: "198.51.100.9" })).status, 200);

  const failing = reportEnv();
  fake.state.failStage = { stage: "issue", status: 500 };
  for (let i = 0; i < REPORTS_PER_HOUR; i += 1) assert.equal((await send(failing, formOf(), { token: null })).status, 502);
  assert.equal((await send(failing, formOf(), { token: null })).status, 429, "a flood of GitHub failures cannot be retried without limit");
});

test("a failed bot check does not use up the sender's reports", async () => {
  const env = guarded();
  for (let i = 0; i < REPORTS_PER_HOUR + 2; i += 1) assert.equal((await send(env, formOf(), { token: null })).status, 403);
  assert.equal(rows(env, "rate_hits"), 0);
  assert.equal((await send(env, formOf())).status, 200);
});

test("with Turnstile configured a report needs a valid token, and a bad one is a 403 before the body is parsed", async () => {
  const env = guarded();
  const missing = await send(env, formOf(), { token: null });
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { error: "bot check failed" });
  verify.respond = () => ({ success: false, "error-codes": ["invalid-input-response"] });
  assert.equal((await send(env, formOf())).status, 403);
  assert.equal((await send(env, formOf({ category: "rant" }))).status, 403, "a bot is turned away before validation runs");
  assert.equal(githubCalls().length, 0);
  assert.equal(fake.repo.issues.length, 0);
});

test("reports answer 503 until the repository and the token are both configured and the repository looks like owner/name", async () => {
  for (const extra of [{ ISSUES_REPO: undefined }, { ISSUES_REPO: "no-slash" }, { ISSUES_REPO: "a/b/c" }, { ISSUES_REPO: "owner/na me" }, { GITHUB_ISSUES_TOKEN: undefined }, { GITHUB_ISSUES_TOKEN: "" }]) {
    const env = reportEnv(extra);
    const res = await send(env, formOf(), { token: null });
    assert.equal(res.status, 503, JSON.stringify(extra));
    assert.equal((await (await get(env, "/api/config")).json()).reports, false);
  }
  assert.equal(githubCalls().length, 0);
});

test("a GitHub failure at any stage is a generic 502 that names neither the repository nor the token, and is logged with stage, status and message only", async () => {
  for (const stage of ["blob", "repo", "branch", "tree", "commit", "ref", "issue"]) {
    const env = guarded();
    fake.state.failStage = { stage, status: 403, message: "Resource not accessible by personal access token" };
    const res = await send(env, formOf({ images: [image()] }));
    assert.equal(res.status, 502, stage);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "could not file the report, try again later" }, stage);
    assert.ok(!text.includes(fake.reportsRepo) && !text.includes(fake.issuesToken), stage);
    const entry = logged.map((l) => JSON.parse(l)).find((l) => l.event === "report_failed");
    assert.deepEqual({ stage: entry.stage, status: entry.status, github: entry.github }, { stage, status: 403, github: "Resource not accessible by personal access token" }, stage);
    assert.equal(fake.repo.issues.length, 0, stage);
  }
});

test("a network error reaching GitHub is a 502 with status 0, and a bad token is a 502", async () => {
  const env = guarded({ GITHUB_API_BASE: "http://127.0.0.1:1" });
  const down = await send(env, formOf());
  assert.equal(down.status, 502);
  assert.equal(JSON.parse(logged.find((l) => l.includes("report_failed"))).status, 0);
  const wrong = guarded({ GITHUB_ISSUES_TOKEN: "wrong-token" });
  assert.equal((await send(wrong, formOf())).status, 502);
});

test("a push race on the default branch is retried with the new head, and gives up after three attempts", async () => {
  const env = guarded();
  fake.state.refConflicts = 2;
  assert.equal((await send(env, formOf({ images: [image()] }))).status, 200);
  const { repo } = fake;
  assert.equal(repo.issues.length, 1);
  assert.equal(repo.trees.get(repo.commits.get(repo.head).tree).size, 1, "the image survives the retries");
  assert.equal(countOf(/\/git\/blobs$/), 1, "blobs are created once");
  assert.equal(countOf(/\/git\/refs\//), 3);

  const stuck = guarded();
  fake.state.refConflicts = 3;
  assert.equal((await send(stuck, formOf({ images: [image()] }))).status, 502);
  assert.equal(fake.repo.issues.length, 0);
});

test("the GitHub API base is the real one unless a test override is set", async () => {
  const urls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (input, init) => { urls.push(new Request(input, init).url); return inner(input, init); };
  try {
    await send(guarded(), formOf(), { token: TOKEN });
    await send(guarded({ GITHUB_API_BASE: "http://127.0.0.1:9" }), formOf());
  } finally {
    globalThis.fetch = inner;
  }
  assert.ok(urls.some((u) => u.startsWith(`https://api.github.com/repos/${fake.reportsRepo}/issues`)));
  assert.ok(urls.some((u) => u.startsWith(`http://127.0.0.1:9/repos/${fake.reportsRepo}/issues`)));
});

test("no secret, token or issue text is ever written to the log", async () => {
  const env = guarded({ GITHUB_ISSUES_TOKEN: fake.issuesToken });
  await send(env, formOf({ title: "secret-title-text", details: "secret-details-text", images: [image()] }));
  verify.respond = () => ({ success: false });
  await send(env, formOf(), {});
  fake.state.failStage = { stage: "issue", status: 500 };
  verify.respond = () => ({ success: true, hostname: "mail.test" });
  await send(env, formOf({ title: "secret-title-text" }));
  const log = logged.join("\n");
  assert.ok(log.includes("report_filed") && log.includes("report_failed") && log.includes("turnstile_rejected"));
  for (const secret of [SECRET, TOKEN, fake.issuesToken, "secret-title-text", "secret-details-text", fake.reportsRepo, "203.0.113.7"]) assert.ok(!log.includes(secret), `log leaked ${secret}`);
});

test("base64 matches the reference encoder for every padding case and a large buffer", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 6, 255, 256, 1000, 4_999_999, 5_000_000]) {
    const bytes = new Uint8Array(crypto.randomBytes(length));
    assert.equal(base64(bytes), Buffer.from(bytes).toString("base64"), String(length));
  }
});
