import { summarize, headerEnd } from "./mime.js";
import { OWNS_SQL, ownershipArgs, ownsRecipient } from "./rules.js";

export const CHUNK_BYTES = 1_440_000;
export const MAX_RAW_BYTES = 25 * 1024 * 1024;
const CHUNKS_PER_BATCH = 3;
const MAX_RECIPIENTS = 20;
const LIST_LIMIT = 200;
const SCRUB_BYTES = 262144;
const ORPHAN_AGE_SECONDS = 3600;

const now = () => Math.floor(Date.now() / 1000);
const latin1 = new TextDecoder("windows-1252");

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value);
}

const SLICE = 32768;

export function encodeChunk(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let out = "";
  for (let at = 0; at < bytes.length; at += SLICE) out += String.fromCharCode.apply(null, bytes.subarray(at, at + SLICE));
  return btoa(out);
}

export function decodeChunk(text) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(text);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export const splitChunks = (bytes) => {
  const parts = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) parts.push(bytes.subarray(at, at + CHUNK_BYTES));
  return parts.length ? parts : [bytes];
};

export async function readAll(raw) {
  if (raw instanceof ReadableStream) return new Uint8Array(await new Response(raw).arrayBuffer());
  return toBytes(raw);
}

function recipientRows(summary, envelope, domain) {
  const seen = new Map();
  const add = (address, kind) => {
    const mail = String(address ?? "").trim().toLowerCase();
    const at = mail.lastIndexOf("@");
    if (at < 1 || mail.slice(at + 1) !== domain || seen.has(mail)) return;
    seen.set(mail, { address: mail, local: mail.slice(0, at), kind });
  };
  for (const p of summary.to) add(p.Address, "to");
  for (const p of summary.cc) add(p.Address, "cc");
  for (const to of envelope?.to ?? []) add(to, "envelope");
  return [...seen.values()].slice(0, MAX_RECIPIENTS);
}

const recipientStatement = (db, id, rows) => db.prepare(
  `INSERT OR IGNORE INTO recipients (message_id, address, local, kind) VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}`,
).bind(...rows.flatMap((r) => [id, r.address, r.local, r.kind]));

export async function ingest(db, raw, envelope, domain) {
  const bytes = await readAll(raw);
  if (bytes.length > MAX_RAW_BYTES) throw new Error(`message exceeds ${MAX_RAW_BYTES} bytes`);
  const summary = await summarize(bytes);
  const rows = recipientRows(summary, envelope, domain);
  if (!rows.length) return { stored: false, reason: "no recipient on this domain", id: summary.id };
  const id = summary.id;
  if (await db.prepare("SELECT 1 AS x FROM messages WHERE id = ?").bind(id).first()) {
    await recipientStatement(db, id, rows).run();
    return { stored: true, duplicate: true, id };
  }
  const created = now();
  const parts = splitChunks(bytes).map(encodeChunk);
  const stored = parts.reduce((n, p) => n + p.length, 0);
  for (let i = 0; i < parts.length; i += CHUNKS_PER_BATCH) {
    await db.batch(parts.slice(i, i + CHUNKS_PER_BATCH).map((part, k) =>
      db.prepare("INSERT OR REPLACE INTO chunks (message_id, seq, created, data) VALUES (?, ?, ?, ?)").bind(id, i + k, created, part)));
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO messages (id, created, from_name, from_addr, to_json, cc_json, subject, date_header, size, stored, attachments, snippet, chunks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, created, summary.from.Name, summary.from.Address, JSON.stringify(summary.to), JSON.stringify(summary.cc), summary.subject, summary.dateHeader, bytes.length, stored, summary.attachments, summary.snippet, parts.length),
    recipientStatement(db, id, rows),
  ]);
  return { stored: true, duplicate: false, id, size: bytes.length, chunks: parts.length };
}

const person = (name, address) => ({ Name: name, Address: address });

export async function listFor(db, username, domain) {
  const found = await db.prepare(
    `SELECT m.id, m.created, m.from_name, m.from_addr, m.to_json, m.cc_json, m.subject, m.size, m.attachments, m.snippet,
            EXISTS (SELECT 1 FROM reads x WHERE x.username = ?1 AND x.id = m.id) AS is_read
       FROM messages m
      WHERE m.id IN (SELECT r.message_id FROM recipients r WHERE r.local = ?1 OR (r.local >= ?2 AND r.local < ?3))
        AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.username = ?1 AND h.id = m.id)
      ORDER BY m.created DESC LIMIT ?4`,
  ).bind(...ownershipArgs(username), LIST_LIMIT + 1).all();
  const rows = found.results ?? [];
  const messages = rows.slice(0, LIST_LIMIT).map((m) => ({
    id: m.id,
    from: person(m.from_name, m.from_addr),
    to: JSON.parse(m.to_json),
    cc: JSON.parse(m.cc_json),
    subject: m.subject,
    created: new Date(m.created * 1000).toISOString(),
    snippet: m.snippet,
    attachments: m.attachments,
    size: m.size,
    read: m.is_read === 1,
  }));
  return { messages, truncated: rows.length > LIST_LIMIT, domain };
}

export async function ownMessage(db, username, id) {
  return db.prepare(
    `SELECT m.id, m.chunks, m.size FROM messages m
      WHERE m.id = ?1
        AND EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND (r.local = ?2 OR (r.local >= ?3 AND r.local < ?4)))
        AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.username = ?2 AND h.id = m.id)`,
  ).bind(id, ...ownershipArgs(username)).first();
}

export const markRead = (db, username, id) => db.prepare("INSERT OR IGNORE INTO reads (username, id) VALUES (?, ?)").bind(username, id).run();
export const hide = (db, username, id) => db.prepare("INSERT OR IGNORE INTO hidden (username, id) VALUES (?, ?)").bind(username, id).run();

export function scrubHead(bytes, username, domain) {
  const { end } = headerEnd(bytes.length > SCRUB_BYTES ? bytes.subarray(0, SCRUB_BYTES) : bytes);
  const head = latin1.decode(bytes.subarray(0, end));
  const foreign = (match, recipient) => (ownsRecipient(username, recipient, domain) ? match : "");
  const clean = head.replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n?/gim, "").replace(/\bfor <([^>]*)>/g, foreign);
  if (clean === head) return bytes;
  const out = new Uint8Array(clean.length + bytes.length - end);
  for (let i = 0; i < clean.length; i += 1) out[i] = clean.charCodeAt(i);
  out.set(bytes.subarray(end), clean.length);
  return out;
}

export function rawStream(db, message, username, domain) {
  let seq = 0;
  return new ReadableStream({
    async pull(controller) {
      if (seq >= message.chunks) return controller.close();
      const data = await db.prepare("SELECT data FROM chunks WHERE message_id = ? AND seq = ?").bind(message.id, seq).first("data");
      if (data == null) return controller.error(new Error("chunk missing"));
      const bytes = decodeChunk(data);
      controller.enqueue(seq === 0 ? scrubHead(bytes, username, domain) : bytes);
      seq += 1;
      if (seq >= message.chunks) controller.close();
    },
  });
}

export async function lastIngest(db) {
  const row = await db.prepare("SELECT MAX(created) AS at FROM messages").first();
  return row?.at ?? null;
}

const JANITOR_BATCH = 20;

export async function janitor(db, { storedBytesCap, sessionSeconds }) {
  const stamp = now();
  const report = { deleted: 0, orphanChunks: 0 };
  const total = (await db.prepare("SELECT COALESCE(SUM(stored), 0) AS bytes FROM messages").first()).bytes;
  if (total > storedBytesCap) {
    const oldest = (await db.prepare("SELECT id, stored FROM messages ORDER BY created ASC LIMIT ?").bind(JANITOR_BATCH).all()).results;
    let excess = total - storedBytesCap;
    const ids = [];
    for (const row of oldest) {
      if (excess <= 0) break;
      ids.push(row.id);
      excess -= row.stored;
    }
    if (ids.length) {
      const marks = ids.map(() => "?").join(", ");
      await db.batch([
        db.prepare(`DELETE FROM chunks WHERE message_id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM hidden WHERE id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM reads WHERE id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM messages WHERE id IN (${marks})`).bind(...ids),
      ]);
      report.deleted = ids.length;
    }
  }
  const orphans = await db.prepare(
    `DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE created < ? AND message_id NOT IN (SELECT id FROM messages) LIMIT 50)`,
  ).bind(stamp - ORPHAN_AGE_SECONDS).run();
  report.orphanChunks = orphans.meta?.changes ?? 0;
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE seen < ?").bind(stamp - sessionSeconds),
    db.prepare("DELETE FROM rate_hits WHERE expires < ?").bind(stamp),
  ]);
  return report;
}

