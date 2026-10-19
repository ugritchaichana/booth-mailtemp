import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DETAILS, MAX_EDGE, MAX_TITLE, checkDraft, fitSize, formatBytes, sentence } from "../public/report.js";

test("fitSize shrinks the long edge to 2000 px, keeps the ratio and never enlarges", () => {
  assert.deepEqual(fitSize(3000, 1500), [MAX_EDGE, 1000]);
  assert.deepEqual(fitSize(1500, 3000), [1000, MAX_EDGE]);
  assert.deepEqual(fitSize(2000, 2000), [2000, 2000]);
  assert.deepEqual(fitSize(640, 480), [640, 480]);
  assert.deepEqual(fitSize(20000, 1), [2000, 1]);
});

test("formatBytes reads in kB below a megabyte and MB above", () => {
  assert.equal(formatBytes(1), "1 kB");
  assert.equal(formatBytes(128_400), "128 kB");
  assert.equal(formatBytes(2_500_000), "2.5 MB");
});

test("checkDraft mirrors the server limits and the time order", () => {
  const ok = { title: "t", details: "d", from: "", to: "" };
  assert.equal(checkDraft(ok), null);
  assert.match(checkDraft({ ...ok, title: "  " }), /title/);
  assert.match(checkDraft({ ...ok, title: "x".repeat(MAX_TITLE + 1) }), /120/);
  assert.match(checkDraft({ ...ok, details: "\n" }), /details/);
  assert.match(checkDraft({ ...ok, details: "x".repeat(MAX_DETAILS + 1) }), /10000/);
  assert.match(checkDraft({ ...ok, from: "2026-10-19T15:00", to: "2026-10-19T14:00" }), /start time is after/);
  assert.equal(checkDraft({ ...ok, from: "2026-10-19T14:00", to: "2026-10-19T15:00" }), null);
  assert.equal(checkDraft({ ...ok, from: "2026-10-19T14:00" }), null);
});

test("sentence capitalises a server message and ends it with one full stop", () => {
  assert.equal(sentence("bot check failed"), "Bot check failed.");
  assert.equal(sentence("Too many reports, try again later."), "Too many reports, try again later.");
});
