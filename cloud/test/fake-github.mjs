import crypto from "node:crypto";
import http from "node:http";

const text = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status,
  headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json", ...headers },
});

export function createFakeGithub({ clientId = "test-client-id", clientSecret = "test-client-secret", origins = null, interactive = false } = {}) {
  const accounts = new Map();
  const codes = new Map();
  const tokens = new Map();
  const state = { approveAs: null, deny: false, failToken: false, failUser: 0, failLookup: 0 };
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
    return text(404, { message: "Not Found" });
  }

  return {
    clientId,
    clientSecret,
    state,
    requests,
    issued,
    handle,
    addAccount: (login, id, type = "User") => accounts.set(login.toLowerCase(), { id, login, type }),
    signInAs: (login) => { state.approveAs = login; },
    reset() {
      requests.length = 0;
      issued.length = 0;
      Object.assign(state, { approveAs: null, deny: false, failToken: false, failUser: 0, failLookup: 0 });
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
