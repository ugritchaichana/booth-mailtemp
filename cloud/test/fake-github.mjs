import crypto from "node:crypto";
import http from "node:http";

const text = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status,
  headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json", ...headers },
});

const sha1 = (...parts) => crypto.createHash("sha1").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");
const EMPTY_TREE = "2".repeat(40);
const ROOT_COMMIT = "1".repeat(40);

const freshRepo = () => ({
  branch: "main",
  head: ROOT_COMMIT,
  commits: new Map([[ROOT_COMMIT, { tree: EMPTY_TREE, parents: [], message: "root" }]]),
  trees: new Map([[EMPTY_TREE, new Map()]]),
  blobs: new Map(),
  issues: [],
});

const REPORT_STAGES = [["GET", /^$/, "repo"], ["GET", /^\/branches\//, "branch"], ["POST", /^\/git\/blobs$/, "blob"], ["POST", /^\/git\/trees$/, "tree"], ["POST", /^\/git\/commits$/, "commit"], ["PATCH", /^\/git\/refs\//, "ref"], ["POST", /^\/issues$/, "issue"]];

export function createFakeGithub({ clientId = "test-client-id", clientSecret = "test-client-secret", origins = null, interactive = false, reportsRepo = "test-owner/test-reports", issuesToken = "test-issues-token" } = {}) {
  const accounts = new Map();
  const codes = new Map();
  const tokens = new Map();
  const state = { approveAs: null, deny: false, failToken: false, failUser: 0, failLookup: 0, failStage: null, refConflicts: 0 };
  let repo = freshRepo();
  const requests = [];
  const issued = [];
  let server = null;

  const account = (login) => accounts.get(String(login).toLowerCase());

  async function handle(request) {
    const url = new URL(request.url);
    const entry = { method: request.method, origin: url.origin, path: url.pathname, authorization: request.headers.get("authorization"), query: Object.fromEntries(url.searchParams) };
    requests.push(entry);
    const onOrigin = (kind) => !origins || url.origin === origins[kind];

    if (request.method === "GET" && url.pathname === "/login/oauth/authorize" && onOrigin("oauth")) {
      const { client_id: id, redirect_uri: redirect, state: csrf } = entry.query;
      if (id !== clientId || !redirect) return text(404, "unknown client");
      const target = new URL(redirect);
      if (state.deny) target.search = new URLSearchParams({ error: "access_denied", state: csrf });
      else {
        const user = account(state.approveAs);
        if (!user) return text(403, "no account chosen");
        const code = crypto.randomBytes(10).toString("hex");
        codes.set(code, { login: user.login, redirect });
        target.search = new URLSearchParams({ code, state: csrf });
      }
      if (interactive) return text(200, `<!doctype html><a id="authorize" href="${target.href.replaceAll("&", "&amp;")}">Authorize</a>`);
      return new Response(null, { status: 302, headers: { Location: target.href } });
    }

    if (request.method === "POST" && url.pathname === "/login/oauth/access_token" && onOrigin("oauth")) {
      const body = await request.json().catch(() => ({}));
      const grant = codes.get(body.code);
      codes.delete(body.code);
      if (state.failToken || body.client_id !== clientId || body.client_secret !== clientSecret || !grant || grant.redirect !== body.redirect_uri) {
        return text(200, { error: "bad_verification_code" });
      }
      const token = `gho_fake${crypto.randomBytes(12).toString("hex")}`;
      tokens.set(token, grant.login);
      issued.push(token);
      return text(200, { access_token: token, token_type: "bearer", scope: "" });
    }

    if (url.pathname === "/user" && request.method === "GET" && onOrigin("api")) {
      const login = tokens.get((entry.authorization ?? "").replace(/^(Bearer|token) /, ""));
      if (state.failUser) return text(state.failUser, { message: "boom" });
      if (!login) return text(401, { message: "Bad credentials" });
      const { id, login: name, type } = account(login);
      return text(200, { id, login: name, type });
    }

    const lookup = /^\/users\/([^/]+)$/.exec(url.pathname);
    if (lookup && request.method === "GET" && onOrigin("api")) {
      if (state.failLookup) return text(state.failLookup, { message: "API rate limit exceeded" });
      const found = account(decodeURIComponent(lookup[1]));
      return found ? text(200, { id: found.id, login: found.login, type: found.type }) : text(404, { message: "Not Found" });
    }
    const scoped = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    if (scoped && onOrigin("api")) return reportsApi(request, entry, scoped[1], scoped[2] ?? "");
    return text(404, { message: "Not Found" });
  }

  async function reportsApi(request, entry, name, rest) {
    if (entry.authorization !== `Bearer ${issuesToken}`) return text(401, { message: "Bad credentials" });
    if (name !== reportsRepo) return text(404, { message: "Not Found" });
    const stage = REPORT_STAGES.find(([method, re]) => method === request.method && re.test(rest))?.[2];
    if (stage && state.failStage?.stage === stage) return text(state.failStage.status ?? 500, { message: state.failStage.message ?? "boom" });
    const body = ["POST", "PATCH"].includes(request.method) ? await request.json().catch(() => ({})) : {};
    const bad = (message) => text(422, { message });

    if (stage === "repo") return text(200, { default_branch: repo.branch });
    if (stage === "branch") {
      if (decodeURI(rest.slice("/branches/".length)) !== repo.branch) return text(404, { message: "Branch not found" });
      return text(200, { name: repo.branch, commit: { sha: repo.head, commit: { tree: { sha: repo.commits.get(repo.head).tree } } } });
    }
    if (stage === "blob") {
      if (body.encoding !== "base64" || typeof body.content !== "string") return bad("encoding must be base64");
      const bytes = Buffer.from(body.content, "base64");
      const sha = sha1(`blob ${bytes.length}\0`, bytes);
      repo.blobs.set(sha, bytes);
      return text(201, { sha });
    }
    if (stage === "tree") {
      const base = repo.trees.get(body.base_tree);
      if (!base || !Array.isArray(body.tree)) return bad("base_tree is invalid");
      const files = new Map(base);
      for (const item of body.tree) {
        if (item.mode !== "100644" || item.type !== "blob" || !repo.blobs.has(item.sha) || typeof item.path !== "string") return bad("tree entry is invalid");
        files.set(item.path, item.sha);
      }
      const sha = sha1(JSON.stringify([...files]));
      repo.trees.set(sha, files);
      return text(201, { sha });
    }
    if (stage === "commit") {
      if (!repo.trees.has(body.tree) || !Array.isArray(body.parents) || !body.parents.every((p) => repo.commits.has(p))) return bad("commit is invalid");
      const sha = sha1(JSON.stringify(body), String(repo.commits.size));
      repo.commits.set(sha, { tree: body.tree, parents: body.parents, message: String(body.message ?? "") });
      return text(201, { sha });
    }
    if (stage === "ref") {
      if (decodeURI(rest.slice("/git/refs/heads/".length)) !== repo.branch) return text(404, { message: "Reference does not exist" });
      if (state.refConflicts > 0) {
        state.refConflicts -= 1;
        const sha = sha1("raced", String(repo.commits.size));
        repo.commits.set(sha, { tree: repo.commits.get(repo.head).tree, parents: [repo.head], message: "raced" });
        repo.head = sha;
      }
      const commit = repo.commits.get(body.sha);
      if (!commit || commit.parents[0] !== repo.head) return bad("Update is not a fast forward");
      repo.head = body.sha;
      return text(200, { ref: `refs/heads/${repo.branch}`, object: { sha: repo.head } });
    }
    if (stage === "issue") {
      if (typeof body.title !== "string" || !body.title || typeof body.body !== "string" || !Array.isArray(body.labels)) return bad("Validation Failed");
      const issue = { number: repo.issues.length + 1, title: body.title, body: body.body, labels: body.labels };
      repo.issues.push(issue);
      return text(201, { number: issue.number, html_url: `https://github.com/${name}/issues/${issue.number}` });
    }
    return text(404, { message: "Not Found" });
  }

  return {
    clientId,
    clientSecret,
    state,
    requests,
    issued,
    reportsRepo,
    issuesToken,
    get repo() { return repo; },
    handle,
    addAccount: (login, id, type = "User") => accounts.set(login.toLowerCase(), { id, login, type }),
    signInAs: (login) => { state.approveAs = login; },
    reset() {
      requests.length = 0;
      issued.length = 0;
      Object.assign(state, { approveAs: null, deny: false, failToken: false, failUser: 0, failLookup: 0, failStage: null, refConflicts: 0 });
      repo = freshRepo();
    },
    async listen(port = 0) {
      server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const out = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }));
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
      });
      await new Promise((resolve) => server.listen(port, resolve));
      return server.address().port;
    },
    close: () => new Promise((resolve) => {
      if (!server) return resolve();
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
