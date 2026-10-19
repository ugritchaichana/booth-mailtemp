import { fail, json, log } from "./http.js";
import { limiter } from "./sessions.js";
import { botCheck } from "./turnstile.js";

export const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export const MAX_TITLE = 120;
export const MAX_DETAILS = 10000;
export const REPORTS_PER_HOUR = 5;
export const CATEGORIES = ["bug", "problem", "suggestion", "other"];

const BODY_SLACK = 256 * 1024;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const BANGKOK_OFFSET_MS = 7 * 3600_000;
const FUTURE_SLACK_MS = 86400_000;
const BLOB_PARALLEL = 3;
const COMMIT_ATTEMPTS = 3;
const GITHUB_TIMEOUT_MS = 15_000;
const SIGNATURES = [["png", "\x89PNG\r\n\x1a\n"], ["jpg", "\xff\xd8\xff"], ["gif", "GIF87a"], ["gif", "GIF89a"]];

export const reportsEnabled = (env) => REPO_RE.test(env.ISSUES_REPO ?? "") && Boolean(env.GITHUB_ISSUES_TOKEN);

const oneLine = (text, max) => clean(text, true).replace(/\s+/g, " ").trim().slice(0, max);
const noMention = (text) => text.replace(/@/g, "@\u200b");
const code = (text) => text.replace(/`/g, "'");
const pad = (n) => String(n).padStart(2, "0");
const utc = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

export function clean(value, keepNewlines) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
  return text.replace(keepNewlines ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "");
}

function sniff(head) {
  const text = String.fromCharCode(...head);
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "webp";
  return SIGNATURES.find(([, signature]) => text.startsWith(signature))?.[0] ?? null;
}

function readTime(value, now) {
  if (value === null || value === "") return { ms: null };
  const ms = typeof value === "string" && TIME_RE.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms <= now + FUTURE_SLACK_MS ? { ms } : { error: "invalid time" };
}

export async function readReport(form, now = Date.now()) {
  const bad = (error, status = 400) => ({ error, status });
  const category = String(form.get("category") ?? "");
  if (!CATEGORIES.includes(category)) return bad("invalid category");
  const title = oneLine(form.get("title"), MAX_TITLE + 1);
  if (!title) return bad("title is required");
  if (title.length > MAX_TITLE) return bad(`title must be at most ${MAX_TITLE} characters`);
  const details = clean(form.get("details"), true).trim();
  if (!details) return bad("details are required");
  if (details.length > MAX_DETAILS) return bad(`details must be at most ${MAX_DETAILS} characters`);
  const from = readTime(form.get("from"), now);
  const to = readTime(form.get("to"), now);
  if (from.error || to.error) return bad("invalid time");
  if (from.ms !== null && to.ms !== null && from.ms > to.ms) return bad("the start time is after the end time");

  const entries = form.getAll("images");
  if (entries.length > MAX_IMAGES) return bad(`at most ${MAX_IMAGES} images`);
  const images = [];
  let total = 0;
  for (const file of entries) {
    if (typeof file === "string") return bad("invalid image");
    if (file.size > MAX_IMAGE_BYTES) return bad(`each image must be at most ${MAX_IMAGE_BYTES / 1048576} MB`, 413);
    total += file.size;
    const ext = sniff(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    if (!ext) return bad("images must be png, jpeg, webp or gif");
    images.push({ file, ext });
  }
  if (total > MAX_TOTAL_BYTES) return bad(`images must total at most ${MAX_TOTAL_BYTES / 1048576} MB`, 413);
  return { report: { category, title: noMention(title), details: noMention(details), from: from.ms, to: to.ms, images, route: noMention(oneLine(form.get("route"), 200)) } };
}

const when = ({ from, to }) => {
  const stamp = (ms) => `${utc(ms + BANGKOK_OFFSET_MS)} Asia/Bangkok (${utc(ms)} UTC)`;
  if (from !== null && to !== null) return `${stamp(from)} to ${stamp(to)}`;
  return from !== null ? `from ${stamp(from)}` : to !== null ? `until ${stamp(to)}` : null;
};

export function issueBody({ report, links, address, agent, reportedAt, version }) {
  const range = when(report);
  const context = [
    address && `- Address: \`${code(address)}\``,
    report.route && `- Page: \`${code(report.route)}\``,
    agent && `- Browser: \`${code(agent)}\``,
    `- Reported: ${utc(reportedAt)} UTC`,
    version && `- Worker version: \`${code(version)}\``,
  ].filter(Boolean);
  return [
    `**Category:** ${report.category}`,
    range && `**When:** ${range}`,
    `### Details\n\n${report.details}`,
    links.length && `### Images\n\n${links.map((url, i) => `![image ${i + 1}](${url})`).join("\n\n")}`,
    `### Context\n\n${context.join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

class GithubError extends Error {
  constructor(stage, status, detail) {
    super(`${stage} ${status}`);
    Object.assign(this, { stage, status, detail });
  }
}

async function github(env, stage, path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${env.GITHUB_API_BASE || "https://api.github.com"}/repos/${env.ISSUES_REPO}${path}`, {
      method,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mailtemp-cloud",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new GithubError(stage, 0, String(err?.name ?? "network"));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GithubError(stage, res.status, String(data?.message ?? "").slice(0, 200));
  return data;
}

const ALPHABET = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const ascii = new TextDecoder();

export function base64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  const { length } = bytes;
  const out = new Uint8Array(Math.ceil(length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = ALPHABET[v >> 18];
    out[o++] = ALPHABET[(v >> 12) & 63];
    out[o++] = ALPHABET[(v >> 6) & 63];
    out[o++] = ALPHABET[v & 63];
  }
  if (i < length) {
    const v = (bytes[i] << 16) | ((i + 1 < length ? bytes[i + 1] : 0) << 8);
    out[o++] = ALPHABET[v >> 18];
    out[o++] = ALPHABET[(v >> 12) & 63];
    out[o++] = i + 1 < length ? ALPHABET[(v >> 6) & 63] : 61;
    out[o++] = 61;
  }
  return ascii.decode(out);
}

async function commitImages(env, images, folder) {
  const shas = new Array(images.length);
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const i = next++;
      const content = base64(new Uint8Array(await images[i].file.arrayBuffer()));
      shas[i] = (await github(env, "blob", "/git/blobs", { method: "POST", body: { content, encoding: "base64" } })).sha;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_PARALLEL, images.length) }, worker));
  const paths = images.map(({ ext }, i) => `${folder}/${i + 1}.${ext}`);
  const { default_branch: branch } = await github(env, "repo", "");
  for (let attempt = 1; ; attempt += 1) {
    const head = await github(env, "branch", `/branches/${encodeURI(branch)}`);
    const tree = await github(env, "tree", "/git/trees", { method: "POST", body: { base_tree: head.commit.commit.tree.sha, tree: paths.map((path, i) => ({ path, mode: "100644", type: "blob", sha: shas[i] })) } });
    const commit = await github(env, "commit", "/git/commits", { method: "POST", body: { message: `report ${folder}`, tree: tree.sha, parents: [head.commit.sha] } });
    try {
      await github(env, "ref", `/git/refs/heads/${encodeURI(branch)}`, { method: "PATCH", body: { sha: commit.sha } });
      return { sha: commit.sha, paths };
    } catch (err) {
      if (err.status !== 422 || attempt >= COMMIT_ATTEMPTS) throw err;
    }
  }
}

function folderName(now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  const [day, time] = stamp.split("T");
  const rand = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `reports/${day.slice(0, 4)}/${day.slice(4, 6)}/${day}-${time}-${rand}`;
}

export async function handleReport(request, env, { ip, active }) {
  if (!reportsEnabled(env)) return fail(503, "reports are not enabled");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_TOTAL_BYTES + BODY_SLACK) return fail(413, "report too large");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return fail(415, "expected multipart/form-data");
  const rate = limiter(env.DB, "report", REPORTS_PER_HOUR, 3600);
  if (await rate.full(ip)) return fail(429, "Too many reports, try again later");
  const blocked = await botCheck(env, request, ip, "report");
  if (blocked) return blocked;
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid form");
  }
  const { report, error, status } = await readReport(form);
  if (error) return fail(status, error);
  await rate.hit(ip);

  const now = Date.now();
  try {
    const folder = folderName(now);
    const committed = report.images.length ? await commitImages(env, report.images, folder) : { sha: "", paths: [] };
    const links = committed.paths.map((path) => `https://github.com/${env.ISSUES_REPO}/blob/${committed.sha}/${path}?raw=true`);
    const body = issueBody({
      report,
      links,
      address: await active(),
      agent: noMention(oneLine(request.headers.get("user-agent"), 200)),
      reportedAt: now,
      version: env.CF_VERSION_METADATA?.id,
    });
    const issue = await github(env, "issue", "/issues", { method: "POST", body: { title: `[${report.category}] ${report.title}`, body, labels: ["report", `report:${report.category}`] } });
    if (!Number.isInteger(issue.number)) throw new GithubError("issue", 200, "response without a number");
    log("report_filed", { number: issue.number, images: report.images.length });
    return json(200, { number: issue.number });
  } catch (err) {
    if (!(err instanceof GithubError)) throw err;
    log("report_failed", { stage: err.stage, status: err.status, github: err.detail });
    return fail(502, "could not file the report, try again later");
  }
}
