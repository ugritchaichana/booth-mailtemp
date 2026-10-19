import crypto from "node:crypto";
import { launchBrowser } from "../../inbox/test/browser.mjs";
import { buildMessage } from "./probe/worker.js";
import { probeIngest, startDev } from "./dev-server.mjs";

const port = Number(process.env.PORT ?? 8798);
const password = crypto.randomBytes(12).toString("hex");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const dev = await startDev({ port, adminPassword: password });
const { base } = dev;
const mails = {
  reserved: { size: 40_000, to: "qa1@booth.pp.ua", id: "adm-reserved", subject: "reserved qa mail" },
  alice: { size: 30_000, to: "alice@booth.pp.ua", id: "adm-alice", subject: "alice mail" },
  bob: { size: 30_000, to: "bob@booth.pp.ua", id: "adm-bob", subject: "bob mail" },
};
let browser;
try {
  for (const mail of Object.values(mails)) await probeIngest(base, dev.token, mail);

  const flat = async (url) => (await fetch(`${base}${url}`, { redirect: "manual" })).status;
  console.log(`serving: /admin=${await flat("/admin")} /admin/=${await flat("/admin/")} /admin.html=${await flat("/admin.html")}`);
  check("/admin is served as a page, not redirected", (await flat("/admin")) === 200);

  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  const deleted = new Set();
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("response", (r) => {
    const expected = (r.status() === 401 && r.url().includes("/api/admin/")) || (r.status() === 404 && /\/api\/admin\/messages\/[^/]+\/raw$/.test(r.url()) && deleted.has(r.url().split("/").at(-2)));
    if (r.status() >= 400 && !expected) problems.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(`${base}/admin`);
  await page.locator("#loginForm").waitFor({ state: "visible" });
  check("signed out: only the login form shows", !(await page.locator("#app").isVisible()) && !(await page.locator("#logout").isVisible()));

  await page.fill("#password", "not-the-password");
  await page.click("#loginGo");
  await page.locator("#loginError").waitFor({ state: "visible" });
  check("a wrong password shows an error and stays signed out", /Wrong password/.test(await page.locator("#loginError").innerText()) && !(await page.locator("#app").isVisible()));

  await page.fill("#password", password);
  await page.click("#loginGo");
  await page.locator("#rows tr").first().waitFor();
  check("signed in: the list shows mail for every name", (await page.locator("#rows tr").count()) === 3);
  check("signed in: the reserved-name mail is listed with its recipient", (await page.locator("#rows tr", { hasText: "qa1@booth.pp.ua" }).count()) === 1);
  const stats = await page.locator("#stats").innerText();
  check("the stats bar shows the counts and sizes", /MESSAGES\s*3/i.test(stats) && /STORED MAIL/i.test(stats) && /400\.0 MB/.test(stats) && /D1 DATABASE\s*\d/i.test(stats), stats);
  check("the password field is cleared after sign in", (await page.inputValue("#password")) === "");

  await page.fill("#search", "qa1");
  await page.press("#search", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr").length === 1);
  check("search narrows the list by recipient", (await page.locator("#rows tr").innerText()).includes("reserved qa mail"));
  await page.fill("#search", "");
  await page.press("#search", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr").length === 3);

  await page.locator("#rows tr", { hasText: "reserved qa mail" }).locator("td").nth(4).click();
  await page.locator("#preview").waitFor();
  check("opening a row routes to the message", /#\/m\/[A-Za-z0-9_-]+$/.test(page.url()));
  check("the HTML view uses the inbox sandbox flags", (await page.getAttribute("#preview", "sandbox")) === "allow-popups allow-popups-to-escape-sandbox");
  check("the HTML view renders the mail body", /Probe adm-reserved/.test(await page.frameLocator("#preview").locator("h1").innerText()));
  await page.click("[data-tab=text]");
  check("the Text tab shows the plain body", /Probe message adm-reserved/.test(await page.locator("pre").innerText()));
  await page.click("[data-tab=headers]");
  check("the Headers tab shows the stored header block", /To: qa1@booth\.pp\.ua/.test(await page.locator("[data-raw-head]").innerText()));
  await page.click("[data-tab=attachments]");
  check("the Attachments tab lists the PDF", /probe\.pdf/.test(await page.locator(".list-group").innerText()));
  const download = page.waitForEvent("download");
  await page.click("#download");
  const file = await download;
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  check("Download .eml gives the stored bytes", file.suggestedFilename() === "message.eml" && sha(Buffer.concat(chunks)) === sha(buildMessage(mails.reserved)));

  await page.click("#back");
  await page.locator("#rows tr").first().waitFor();
  check("Back returns to the list", (await page.locator("#rows tr").count()) === 3 && !(await page.locator("#viewPane").isVisible()));

  const aliceId = await page.evaluate(async () => (await (await fetch("/api/admin/messages?q=alice")).json()).messages[0].id);
  await page.locator("#rows tr", { hasText: "alice mail" }).locator("input[type=checkbox]").check();
  await page.locator("#rows tr", { hasText: "bob mail" }).locator("input[type=checkbox]").check();
  check("selecting rows enables Delete selected with a count", /\(2\)/.test(await page.locator("#deleteSelected").innerText()) && (await page.locator("#deleteSelected").isEnabled()));
  await page.click("#deleteSelected");
  check("Delete selected asks for confirmation first", /Delete 2 messages permanently/.test(await page.locator("#confirmText").innerText()) && (await page.locator("#rows tr").count()) === 3);
  await page.click("#confirmNo");
  check("Cancel keeps every message", !(await page.locator("#confirm").isVisible()) && (await page.locator("#rows tr").count()) === 3);
  deleted.add(aliceId);
  await page.click("#deleteSelected");
  await page.click("#confirmYes");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr").length === 1);
  check("confirming deletes only the selected messages", (await page.locator("#rows tr").innerText()).includes("reserved qa mail"));
  await page.waitForFunction(() => /MESSAGES\s*1/i.test(document.getElementById("stats").innerText));
  check("the stats bar updates after a delete", true);
  check("a deleted message is gone from the server", (await page.evaluate(async (id) => (await fetch(`/api/admin/messages/${id}/raw`)).status, aliceId)) === 404);

  await page.click("#logout");
  await page.locator("#loginForm").waitFor({ state: "visible" });
  await page.reload();
  await page.locator("#loginForm").waitFor({ state: "visible" });
  check("after sign out the admin API refuses the browser and the login form returns", (await page.evaluate(async () => (await fetch("/api/admin/stats")).status)) === 401);
  check("no script errors or unexpected failed requests", problems.length === 0, problems.join(" | "));
} finally {
  await browser?.close();
  await dev.stop();
}
console.log(failures ? `admin browser check: ${failures} FAILED` : "admin browser check: all checks passed");
process.exit(failures ? 1 : 0);
