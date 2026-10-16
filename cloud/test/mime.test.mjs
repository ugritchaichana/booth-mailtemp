import test from "node:test";
import assert from "node:assert/strict";
import { decodeWords, parseAddresses, summarize } from "../src/mime.js";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const bytes = (text) => new TextEncoder().encode(text);

test("RFC 2047 base64 and Q words decode, Thai included", () => {
  assert.equal(decodeWords(`=?UTF-8?B?${b64("ทดสอบระบบอีเมล")}?=`), "ทดสอบระบบอีเมล");
  assert.equal(decodeWords("=?UTF-8?Q?caf=C3=A9_au_lait?="), "café au lait");
  assert.equal(decodeWords("=?TIS-620?Q?=B7=B4=CA=CD=BA?="), "ทดสอบ");
  assert.equal(decodeWords("=?ISO-8859-1?Q?Andr=E9?= Smith"), "André Smith");
});

test("adjacent encoded words join without the gap, even when a character is split across them", () => {
  const whole = Buffer.from("สวัสดี", "utf8");
  const first = whole.subarray(0, 4).toString("base64");
  const second = whole.subarray(4).toString("base64");
  assert.equal(decodeWords(`=?UTF-8?B?${first}?=\r\n =?UTF-8?B?${second}?=`), "สวัสดี");
  assert.equal(decodeWords(`=?UTF-8?B?${b64("ก")}?= =?UTF-8?B?${b64("ข")}?=`), "กข");
});

test("plain text and malformed words pass through", () => {
  assert.equal(decodeWords("Quarterly report"), "Quarterly report");
  assert.equal(typeof decodeWords("=?UTF-8?B?!!!?="), "string");
  assert.equal(decodeWords("=?no-such-charset?Q?abc?="), "abc");
});

test("address lists keep quoted commas, decode names and drop junk", () => {
  const list = parseAddresses(`"Doe, Jane" <jane@example.com>, =?UTF-8?B?${b64("สมชาย")}?= <som@example.com>, bare@example.com (comment), not-an-address, <angle@example.com>`);
  assert.deepEqual(list, [
    { Name: "Doe, Jane", Address: "jane@example.com" },
    { Name: "สมชาย", Address: "som@example.com" },
    { Name: "", Address: "bare@example.com" },
    { Name: "", Address: "angle@example.com" },
  ]);
});

const message = (headers, body = "hello") => bytes(`${headers.join("\r\n")}\r\n\r\n${body}`);

test("summary reads headers only: subject, from, to, cc, date, snippet", async () => {
  const s = await summarize(message([
    "From: =?UTF-8?B?" + b64("ระบบ") + "?= <noreply@example.com>",
    "To: cloudcheck@booth.pp.ua, other@example.com",
    "Cc: cloudcheck+01@booth.pp.ua",
    "Subject: =?UTF-8?B?" + b64("ยืนยัน") + "?=",
    "Date: Fri, 16 Oct 2026 10:00:00 +0000",
    "Message-ID: <a@example.com>",
    "Content-Type: text/plain; charset=utf-8",
  ], "line one\r\nline two"));
  assert.equal(s.subject, "ยืนยัน");
  assert.deepEqual(s.from, { Name: "ระบบ", Address: "noreply@example.com" });
  assert.equal(s.to.length, 2);
  assert.equal(s.cc[0].Address, "cloudcheck+01@booth.pp.ua");
  assert.equal(s.dateHeader, "Fri, 16 Oct 2026 10:00:00 +0000");
  assert.equal(s.snippet, "line one line two");
  assert.equal(s.attachments, 0);
});

test("folded headers unfold and a lone LF header block parses", async () => {
  const raw = bytes("Subject: first\n second\nFrom: a@example.com\n\nbody");
  assert.equal((await summarize(raw)).subject, "first second");
});

test("attachment heuristic: mixed with a named part, an inline-only message, and a large mixed message", async () => {
  const mixed = message(["From: a@example.com", "Content-Type: multipart/mixed; boundary=x"],
    "--x\r\nContent-Type: text/plain\r\n\r\nhi\r\n--x\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\n\r\nJVBER\r\n--x--");
  assert.equal((await summarize(mixed)).attachments, 1);
  const alternative = message(["From: a@example.com", "Content-Type: multipart/alternative; boundary=y"],
    "--y\r\nContent-Type: text/plain\r\n\r\nhi\r\n--y\r\nContent-Type: text/html\r\n\r\n<p>hi</p>\r\n--y--");
  assert.equal((await summarize(alternative)).attachments, 0);
  const large = new Uint8Array(300_000);
  const head = bytes("From: a@example.com\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain\r\n\r\n");
  large.set(head);
  assert.equal((await summarize(large)).attachments, 1);
});

test("the id is stable across copies that differ only in trace headers, and differs for different bodies", async () => {
  const base = ["From: a@example.com", "Message-ID: <m1@example.com>", "Subject: s", "Date: Fri, 16 Oct 2026 10:00:00 +0000"];
  const one = await summarize(message(["Received: from x for <a@booth.pp.ua>", ...base], "same body"));
  const two = await summarize(message(["Received: from y for <b@booth.pp.ua>", "X-Extra: 1", ...base], "same body"));
  const other = await summarize(message(base, "different body"));
  assert.equal(one.id, two.id);
  assert.notEqual(one.id, other.id);
  assert.match(one.id, /^[0-9a-f]{32}$/);
});
