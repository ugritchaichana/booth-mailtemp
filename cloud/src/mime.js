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

const SNIPPET_MAX_MESSAGE_BYTES = 1_048_576;
const SNIPPET_PLAIN_BYTES = 16384;
const SNIPPET_HTML_BYTES = 131072;
const SNIPPET_SCAN_BYTES = 262144;
const MAX_MIME_DEPTH = 6;
const MAX_MIME_PARTS = 50;
const BLOCK_TAGS = new Set(["br", "p", "div", "tr", "td", "th", "li", "ul", "ol", "table", "blockquote", "section", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
const SKIPPED_TAGS = new Set(["head", "style", "script", "title"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", zwnj: "", zwj: "", shy: "", ndash: "-", mdash: "-", hellip: "..." };
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u2060\ufeff]/g;

function parameter(header, name) {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header ?? "");
  return match ? (match[1] ?? match[2]) : "";
}

function partRanges(bytes, start, boundary) {
  const text = latin1.decode(bytes.subarray(start, start + SNIPPET_SCAN_BYTES));
  const marker = `--${boundary}`;
  const ranges = [];
  let from = text.indexOf(marker);
  while (from >= 0 && ranges.length < MAX_MIME_PARTS) {
    if (from > 0 && text[from - 1] !== "\n") {
      from = text.indexOf(marker, from + marker.length);
      continue;
    }
    const tail = from + marker.length;
    if (text.startsWith("--", tail)) break;
    const lineEnd = text.indexOf("\n", tail);
    if (lineEnd < 0) break;
    const next = text.indexOf(`\n${marker}`, lineEnd);
    const end = next < 0 ? text.length : text[next - 1] === "\r" ? next - 1 : next;
    ranges.push([start + lineEnd + 1, start + Math.max(end, lineEnd + 1)]);
    if (next < 0) break;
    from = next + 1;
  }
  return ranges;
}

function findText(bytes, headers, bodyStart, depth, found) {
  const type = typeOf(headers);
  if ((headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment")) return;
  if (type.startsWith("multipart/")) {
    const boundary = parameter(headers.get("content-type"), "boundary");
    if (!boundary || depth >= MAX_MIME_DEPTH) return;
    for (const [from, to] of partRanges(bytes, bodyStart, boundary)) {
      const part = bytes.subarray(from, to);
      const blank = part[0] === 10 || (part[0] === 13 && part[1] === 10);
      findText(part, blank ? new Map() : parseHeaderBlock(part), blank ? (part[0] === 10 ? 1 : 2) : headerEnd(part).body, depth + 1, found);
      if (found.plain) return;
    }
    return;
  }
  const kind = !type || type.startsWith("text/plain") ? "plain" : type.startsWith("text/html") ? "html" : null;
  if (kind && !found[kind]) found[kind] = { bytes, headers, bodyStart };
}

function transferDecode(bytes, encoding) {
  if (encoding === "base64") {
    const clean = latin1.decode(bytes).replace(/[^A-Za-z0-9+/]/g, "");
    const binary = atob(clean.slice(0, clean.length - (clean.length % 4)));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  if (encoding !== "quoted-printable") return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes[i];
    if (c !== 61) {
      out[n++] = c;
      continue;
    }
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else if (bytes[i + 1] === 10) i += 1;
    else if (bytes[i + 1] === 13 && bytes[i + 2] === 10) i += 2;
    else out[n++] = c;
  }
  return out.subarray(0, n);
}

function entity(match, body) {
  if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? match;
  const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
}

export function stripHtml(html) {
  const lower = html.toLowerCase();
  const unclosed = new Set();
  let out = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) break;
    out += html.slice(at, open);
    if (lower.startsWith("<!--", open)) {
      const close = lower.indexOf("-->", open + 4);
      at = close < 0 ? html.length : close + 3;
      out += " ";
      continue;
    }
    const close = html.indexOf(">", open);
    if (close < 0) {
      at = html.length;
      break;
    }
    const tag = /^<(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(open, open + 24));
    at = close + 1;
    if (!tag) continue;
    if (!tag[1] && SKIPPED_TAGS.has(tag[2]) && !unclosed.has(tag[2])) {
      const end = lower.indexOf(`</${tag[2]}`, at);
      if (end >= 0) at = end;
      else unclosed.add(tag[2]);
    }
    if (BLOCK_TAGS.has(tag[2]) || SKIPPED_TAGS.has(tag[2])) out += " ";
  }
  return (out + html.slice(at)).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity);
}

function decodePart({ bytes, headers, bodyStart }, html) {
  const encoding = (headers.get("content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  const raw = transferDecode(bytes.subarray(bodyStart, bodyStart + (html ? SNIPPET_HTML_BYTES : SNIPPET_PLAIN_BYTES)), encoding);
  const text = charsetDecode(parameter(headers.get("content-type"), "charset") || "utf-8", raw);
  return html ? stripHtml(text) : text;
}

const tidy = (text) => text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);

export function snippetOf(bytes, headers = parseHeaderBlock(bytes), bodyStart = headerEnd(bytes).body) {
  if (bytes.length >= SNIPPET_MAX_MESSAGE_BYTES) return "";
  try {
    const found = {};
    findText(bytes, headers, bodyStart, 0, found);
    const part = found.plain ?? found.html;
    return part ? tidy(decodePart(part, !found.plain)) : "";
  } catch {
    return "";
  }
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
