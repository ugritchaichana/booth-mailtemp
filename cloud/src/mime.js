const HEADER_SCAN_BYTES = 65536;
const BODY_PREFIX_BYTES = 32768;
const ATTACHMENT_SCAN_BYTES = 131072;
const SNIPPET_CHARS = 200;
const MAX_LIST = 50;
const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
const ENCODED_GAP = /(\?=)\s+(=\?)/g;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("windows-1252");

export function decodeText(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

function charsetDecode(charset, bytes) {
  const label = charset.split("*")[0].toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function wordBytes(encoding, payload) {
  if (/b/i.test(encoding)) {
    const clean = payload.replace(/[^A-Za-z0-9+/]/g, "");
    return Uint8Array.from(atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  }
  const text = payload.replace(/_/g, " ");
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function decodeWords(value) {
  const text = String(value).replace(ENCODED_GAP, "$1$2");
  let result = "";
  let last = 0;
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const bytes = new Uint8Array(pending.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of pending.parts) {
      bytes.set(part, at);
      at += part.length;
    }
    result += charsetDecode(pending.charset, bytes);
    pending = null;
  };
  for (const match of text.matchAll(ENCODED_WORD)) {
    const between = text.slice(last, match.index);
    if (between) {
      flush();
      result += between;
    }
    last = match.index + match[0].length;
    let bytes;
    try {
      bytes = wordBytes(match[2], match[3]);
    } catch {
      flush();
      result += match[0];
      continue;
    }
    if (pending && pending.charset.toLowerCase() === match[1].toLowerCase()) pending.parts.push(bytes);
    else {
      flush();
      pending = { charset: match[1], parts: [bytes] };
    }
  }
  flush();
  return result + text.slice(last);
}

function splitTopLevel(list) {
  const parts = [];
  let angle = 0;
  let paren = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(") paren += 1;
    else if (c === ")" && paren) paren -= 1;
    else if (!paren && c === "<") angle += 1;
    else if (!paren && c === ">" && angle) angle -= 1;
    else if ((c === "," || c === ";") && !angle && !paren) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const unquote = (s) => s.trim().replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1");
const stripComments = (s) => s.replace(/\((?:\\.|[^()\\])*\)/g, " ").replace(/\s+/g, " ").trim();

export function parseAddresses(value) {
  const out = [];
  for (const part of splitTopLevel(String(value ?? ""))) {
    const bracket = /^(.*?)<([^<>]*)>\s*$/s.exec(part);
    const address = (bracket ? bracket[2] : stripComments(part)).trim();
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) continue;
    const name = bracket ? decodeWords(unquote(stripComments(bracket[1]))).trim() : "";
    out.push({ Name: name, Address: address });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

export function headerEnd(bytes) {
  const limit = Math.min(bytes.length, HEADER_SCAN_BYTES);
  for (let i = 0; i < limit - 1; i += 1) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { end: i, body: i + 2 };
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return { end: i, body: i + 4 };
  }
  return { end: limit, body: limit };
}

export function parseHeaderBlock(bytes) {
  const { end } = headerEnd(bytes);
  const headers = new Map();
  let name = null;
  for (const line of decodeText(bytes.subarray(0, end)).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && name) {
      headers.set(name, `${headers.get(name)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      name = null;
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(key)) {
      name = null;
      continue;
    }
    name = key;
    headers.set(key, line.slice(colon + 1).trim());
  }
  return headers;
}

const typeOf = (headers) => (headers.get("content-type") ?? "").toLowerCase();

function hasAttachment(bytes, headers) {
  const type = typeOf(headers);
  if (!type.startsWith("multipart/")) return /;\s*name\*?=/.test(type) || /^\s*attachment/i.test(headers.get("content-disposition") ?? "");
  const head = latin1.decode(bytes.subarray(0, ATTACHMENT_SCAN_BYTES));
  if (/^content-disposition:\s*attachment/im.test(head) || /^content-(?:type|disposition):[^\n]*;\s*\r?\n?[ \t]*name\*?=/im.test(head)) return true;
  return type.startsWith("multipart/mixed") && bytes.length > ATTACHMENT_SCAN_BYTES;
}

function snippetOf(bytes, headers, bodyStart) {
  const type = typeOf(headers);
  const encoding = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  if ((type && !type.startsWith("text/plain")) || (encoding !== "7bit" && encoding !== "8bit")) return "";
  return decodeText(bytes.subarray(bodyStart, bodyStart + 2000)).replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function messageId(headers, bytes, bodyStart) {
  const keys = ["message-id", "from", "date", "subject", "content-type"].map((k) => headers.get(k) ?? "");
  const head = new TextEncoder().encode(`${keys.join("\n")}\n`);
  const prefix = bytes.subarray(bodyStart, bodyStart + BODY_PREFIX_BYTES);
  const joined = new Uint8Array(head.length + prefix.length);
  joined.set(head);
  joined.set(prefix, head.length);
  return toHex(await crypto.subtle.digest("SHA-256", joined)).slice(0, 32);
}

export async function summarize(bytes) {
  const headers = parseHeaderBlock(bytes);
  const { body } = headerEnd(bytes);
  return {
    id: await messageId(headers, bytes, body),
    from: parseAddresses(headers.get("from"))[0] ?? { Name: "", Address: "" },
    to: parseAddresses(headers.get("to")),
    cc: parseAddresses(headers.get("cc")),
    subject: decodeWords(headers.get("subject") ?? ""),
    dateHeader: headers.get("date") ?? "",
    attachments: hasAttachment(bytes, headers) ? 1 : 0,
    snippet: snippetOf(bytes, headers, body),
  };
}
