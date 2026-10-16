import test from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "./d1-shim.mjs";
import { SESSION_SECONDS, limiter, openAccounts } from "../src/sessions.js";
import { ownsRecipient, usernameError } from "../src/rules.js";

const KEY = "unit-test-key";
const cookieOf = (setCookie) => setCookie.split(";")[0];
const flip = (value) => value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");

async function browser(accounts, name = "alice") {
  const sid = await accounts.start();
  await accounts.open(name);
  await accounts.add(sid, name);
  return { sid, cookie: cookieOf((await accounts.issue(sid, true))[0]) };
}

test("plain names and +tag names are accepted", () => {
  for (const name of ["abc", "test", "test+1", "alice.b-c_d+x.y_z-9", `${"a".repeat(30)}+${"b".repeat(30)}`, "alice+qa"]) {
    assert.equal(usernameError(name), null, name);
  }
});

test("malformed +tag names are refused", () => {
  const bad = ["test+", "+1", "test++1", "test+a+b", "test+a b", "test+A", "test+1\n", `test+${"b".repeat(31)}`, "ab+1", "test+1@booth.pp.ua"];
  for (const name of bad) assert.match(usernameError(name) ?? "", /username must be/, name);
});

test("reserved names stay reserved on their base part", () => {
  for (const name of ["qa-team", "qa-team+1", "qa1+x", "h13+x", "root+1", "admin+x", "no-reply+a", "support+1"]) {
    assert.equal(usernameError(name), "username not available", name);
  }
});

test("a name owns exactly its own address and its own +sub-tags on the shared domain", () => {
  const to = (local, domain = "booth.pp.ua") => `${local}@${domain}`;
  assert.equal(ownsRecipient("test+1", to("test+1"), "booth.pp.ua"), true);
  assert.equal(ownsRecipient("test+1", to("test+1+x"), "booth.pp.ua"), true);
  assert.equal(ownsRecipient("test+1", to("TEST+1", "BOOTH.PP.UA"), "booth.pp.ua"), true);
  assert.equal(ownsRecipient("test", to("test+1"), "booth.pp.ua"), true);
  assert.equal(ownsRecipient("test+1", to("test"), "booth.pp.ua"), false);
  assert.equal(ownsRecipient("test+1", to("test+10"), "booth.pp.ua"), false);
  assert.equal(ownsRecipient("test", to("testing"), "booth.pp.ua"), false);
  assert.equal(ownsRecipient("test", to("test", "example.com"), "booth.pp.ua"), false);
  assert.equal(ownsRecipient("test", "test", "booth.pp.ua"), false);
});

test("a signed cookie restores the session; a tampered, foreign-key or garbage cookie does not", async () => {
  const db = openD1();
  const accounts = openAccounts(db, KEY);
  const { cookie, sid } = await browser(accounts);
  const restored = await accounts.sessionFrom(cookie);
  assert.deepEqual(restored, { sid, accounts: ["alice"], active: "alice" });
  assert.equal(await accounts.sessionFrom(flip(cookie)), null);
  assert.equal(await accounts.sessionFrom(cookie.replace(/^inboxes=/, "inboxes=x")), null);
  assert.equal(await accounts.sessionFrom("inboxes=garbage"), null);
  assert.equal(await accounts.sessionFrom(""), null);
  assert.equal(await openAccounts(db, "another-key").sessionFrom(cookie), null);
});

test("a cookie older than a year is refused even with a valid signature", async () => {
  const db = openD1();
  const accounts = openAccounts(db, KEY);
  const sid = await accounts.start();
  await accounts.open("alice");
  await accounts.add(sid, "alice");
  const realNow = Date.now;
  Date.now = () => realNow() - (SESSION_SECONDS + 10) * 1000;
  const old = cookieOf((await accounts.issue(sid, true))[0]);
  Date.now = realNow;
  assert.equal(await accounts.sessionFrom(old), null);
});

test("unlimited addresses per browser: order, switch, and forget fall back to the latest", async () => {
  const db = openD1();
  const accounts = openAccounts(db, KEY);
  const { sid } = await browser(accounts, "name-000");
  for (let i = 1; i < 60; i += 1) {
    await accounts.open(`name-${String(i).padStart(3, "0")}`);
    await accounts.add(sid, `name-${String(i).padStart(3, "0")}`);
  }
  let view = await accounts.activate(sid, "name-010");
  assert.equal(view.accounts.length, 60);
  assert.equal(view.active, "name-010");
  view = await accounts.forget(sid, "name-010");
  assert.equal(view.accounts.length, 59);
  assert.equal(view.active, "name-059");
  view = await accounts.forget(sid, "name-000");
  assert.equal(view.active, "name-059");
});

test("forgetting the last address ends the session", async () => {
  const db = openD1();
  const accounts = openAccounts(db, KEY);
  const { cookie, sid } = await browser(accounts);
  assert.equal(await accounts.forget(sid, "alice"), null);
  assert.equal(await accounts.sessionFrom(cookie), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"), 0);
});

test("two browsers sharing a name keep separate address lists", async () => {
  const db = openD1();
  const accounts = openAccounts(db, KEY);
  const one = await browser(accounts, "shared");
  const two = await browser(accounts, "shared");
  await accounts.open("only-one");
  await accounts.add(one.sid, "only-one");
  assert.deepEqual((await accounts.sessionFrom(one.cookie)).accounts, ["shared", "only-one"]);
  assert.deepEqual((await accounts.sessionFrom(two.cookie)).accounts, ["shared"]);
});

test("open reports creation once", async () => {
  const accounts = openAccounts(openD1(), KEY);
  assert.deepEqual(await accounts.open("fresh"), { created: true });
  assert.deepEqual(await accounts.open("fresh"), { created: false });
  assert.equal(await accounts.exists("fresh"), true);
  assert.equal(await accounts.exists("absent"), false);
});

test("the cookie is HttpOnly, SameSite=Lax, and Secure only over https", async () => {
  const accounts = openAccounts(openD1(), KEY);
  const sid = await accounts.start();
  const [secure] = await accounts.issue(sid, true);
  const [plain] = await accounts.issue(sid, false);
  for (const c of [secure, plain]) assert.match(c, /HttpOnly; SameSite=Lax; Path=\//);
  assert.match(secure, /; Secure$/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(accounts.clear()[0], /Max-Age=0/);
});

test("the rate limiter blocks after the cap within a window and is per key", async () => {
  const db = openD1();
  const limit = limiter(db, "random", 3, 60);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await limit.full("1.1.1.1"), false);
    await limit.hit("1.1.1.1");
  }
  assert.equal(await limit.full("1.1.1.1"), true);
  assert.equal(await limit.full("2.2.2.2"), false);
});
