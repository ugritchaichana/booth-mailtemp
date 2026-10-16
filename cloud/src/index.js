import { WorkerEntrypoint } from "cloudflare:workers";
import { handle } from "./api.js";
import { ingest, janitor } from "./store.js";
import { SESSION_SECONDS } from "./sessions.js";

const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

export default class MailtempCloud extends WorkerEntrypoint {
  async fetch(request) {
    try {
      return await handle(request, this.env, this.ctx);
    } catch (err) {
      log("error", { error: String(err?.message ?? err) });
      return new Response(JSON.stringify({ error: "mail store unavailable" }), { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }

  async ingest(raw, envelope) {
    const result = await ingest(this.env.DB, raw, envelope, this.env.MAIL_DOMAIN);
    log("ingest", { id: result.id, stored: result.stored, duplicate: result.duplicate ?? false, size: result.size ?? null, chunks: result.chunks ?? null });
    return result;
  }

  async scheduled() {
    const report = await janitor(this.env.DB, { storedBytesCap: Number(this.env.STORED_BYTES_CAP), sessionSeconds: SESSION_SECONDS });
    log("janitor", report);
  }
}
