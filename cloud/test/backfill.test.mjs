import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openD1 } from "./d1-shim.mjs";
import { ingest } from "../src/store.js";
import { buildBackfill } from "../../tools/backfill-snippets.mjs";

const DATABASE = "11111111-2222-3333-4444-555555555555";
const DOMAIN = "booth.pp.ua";
const head = (id, extra) => `From: a@example.com\r\nTo: alice@booth.pp.ua\r\nSubject: s\r\nMessage-ID: <${id}@example.com>\r\n${extra}\r\n\r\n`;
const mail = (id, extra, body) => new TextEncoder().encode(head(id, extra) + body);
const embedded = () => fs.readFileSync(new URL("../src/mime.js", import.meta.url), "utf8").replace(/^export (?=(?:async )?function|const)/gm, "");

function sandbox(db) {
  const calls = [];
  const cloudflare = {
    async request({ path, body }) {
      assert.equal(path, `/accounts/acct/d1/database/${DATABASE}/query`);
      calls.push(body.sql);
      const statement = db.prepare(body.sql).bind(...body.params);
      const meta = /^\s*UPDATE/i.test(body.sql) ? statement.run().meta : {};
      return { success: true, result: [{ results: /^\s*SELECT/i.test(body.sql) ? statement.all().results : [], meta }] };
    },
  };
  return { calls, run: (code) => new Function("cloudflare", "accountId", `return (${code})()`)(cloudflare, "acct") };
}

async function seeded() {
  const db = openD1();
  const env = { to: ["alice@booth.pp.ua"] };
  const ids = {};
  const add = async (name, raw) => { ids[name] = (await ingest(db, raw, env, DOMAIN)).id; };
  await add("qp", mail("qp", "Content-Type: multipart/alternative; boundary=b", "--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=C3=A9 one\r\n--b--\r\n"));
  await add("html", mail("html", "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64", Buffer.from("<p>สวัสดี html</p>").toString("base64")));
  await add("pdf", mail("pdf", "Content-Type: application/pdf", "JVBER"));
  await add("big", mail("big", "Content-Type: text/plain", "x".repeat(1_100_000)));
  db.raw.exec("UPDATE messages SET snippet = ''");
  return { db, ids };
}

const snippetOfId = (db, id) => db.raw.prepare("SELECT snippet FROM messages WHERE id = ?").get(id).snippet;

test("the generated function embeds mime.js verbatim and fills only empty snippets of small mail", async () => {
  const code = buildBackfill({ database: DATABASE });
  assert.ok(code.startsWith("async () => {"));
  assert.ok(code.includes(embedded()));
  const { db, ids } = await seeded();
  db.raw.prepare("UPDATE messages SET snippet = 'kept' WHERE id = ?").run(ids.qp);
  const result = await sandbox(db).run(code);
  assert.deepEqual([result.selected, result.updated, result.empty, result.failed, result.dry], [2, 1, 1, 0, false]);
  assert.deepEqual(result.samples, ["สวัสดี html"]);
  assert.deepEqual(Object.keys(result).sort(), ["dry", "empty", "failed", "lastId", "remaining", "samples", "selected", "updated"]);
  assert.deepEqual([ids.qp, ids.html, ids.pdf, ids.big].map((id) => snippetOfId(db, id)), ["kept", "สวัสดี html", "", ""]);
});

test("a full pass fills the readable mail, the id cursor skips empties, and dry writes nothing", async () => {
  const { db } = await seeded();
  const { run, calls } = sandbox(db);
  const dry = await run(buildBackfill({ database: DATABASE, dry: true }));
  assert.deepEqual([dry.selected, dry.updated, dry.dry], [3, 2, true]);
  assert.ok(!calls.some((sql) => /^\s*UPDATE/i.test(sql)));
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE snippet <> ''").get().n, 0);
  const first = await run(buildBackfill({ database: DATABASE }));
  assert.deepEqual([first.updated, first.empty, first.remaining], [2, 1, 1]);
  const next = await run(buildBackfill({ database: DATABASE, after: first.lastId }));
  assert.deepEqual([next.selected, next.updated], [0, 0]);
  assert.equal((await run(buildBackfill({ database: DATABASE }))).updated, 0);
});

test("the tool refuses a bad database id, limit or cursor", () => {
  assert.throws(() => buildBackfill({ database: "nope" }), /database/);
  assert.throws(() => buildBackfill({ database: DATABASE, limit: 0 }), /limit/);
  assert.throws(() => buildBackfill({ database: DATABASE, after: "a'b" }), /after/);
});
