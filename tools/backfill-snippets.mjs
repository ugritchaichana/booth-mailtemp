import fs from "node:fs";
import { pathToFileURL } from "node:url";

const MIME_SOURCE = new URL("../cloud/src/mime.js", import.meta.url);
const UUID = /^[0-9a-f-]{36}$/i;
const SAMPLE_CHARS = 60;

export function buildBackfill({ database, limit = 20, after = "", dry = false }) {
  if (!UUID.test(database ?? "")) throw new Error("--database must be the D1 database id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error("--limit must be an integer from 1 to 40");
  if (!/^[A-Za-z0-9_-]*$/.test(after)) throw new Error("--after must be a message id");
  const mime = fs.readFileSync(MIME_SOURCE, "utf8").replace(/^export (?=(?:async )?function|const)/gm, "");
  return `async () => {
${mime}
const database = ${JSON.stringify(database)};
const query = async (sql, params = []) => {
  const res = await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/d1/database/\${database}/query\`, body: { sql, params } });
  if (!res.success) throw new Error("d1 query failed");
  return res.result[0];
};
const rows = (await query("SELECT id FROM messages WHERE snippet = '' AND size < ${1_048_576} AND id > ?1 ORDER BY id LIMIT ?2", [${JSON.stringify(after)}, ${limit}])).results;
const counts = { selected: rows.length, updated: 0, empty: 0, failed: 0 };
const samples = [];
for (const { id } of rows) {
  try {
    const chunk = (await query("SELECT data FROM chunks WHERE message_id = ?1 AND seq = 0", [id])).results[0];
    if (!chunk) { counts.failed += 1; continue; }
    const snippet = snippetOf(Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)));
    if (!snippet) { counts.empty += 1; continue; }
    ${dry ? "counts.updated += 1;" : 'counts.updated += (await query("UPDATE messages SET snippet = ?1 WHERE id = ?2 AND snippet = \'\'", [snippet, id])).meta.changes;'}
    if (samples.length < 3) samples.push(snippet.slice(0, ${SAMPLE_CHARS}));
  } catch {
    counts.failed += 1;
  }
}
const left = (await query("SELECT COUNT(*) AS n FROM messages WHERE snippet = '' AND size < ${1_048_576}")).results[0].n;
return { ...counts, dry: ${dry}, lastId: rows.at(-1)?.id ?? null, remaining: left, samples };
}`;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry") options.dry = true;
    else if (flag === "--database") options.database = argv[++i];
    else if (flag === "--after") options.after = argv[++i];
    else if (flag === "--limit") options.limit = Number(argv[++i]);
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${buildBackfill(parseArgs(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: node tools/backfill-snippets.mjs --database <d1 id> [--limit 20] [--after <last id>] [--dry]\n`);
    process.exit(1);
  }
}
