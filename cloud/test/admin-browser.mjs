import crypto from "node:crypto";
import { launchBrowser } from "../../inbox/test/browser.mjs";
import { buildMessage } from "./probe/worker.js";
import { SSO_USERS, probeIngest, startSsoDev } from "./dev-server.mjs";

const port = Number(process.env.PORT ?? 8798);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const dev = await startSsoDev({ port, interactive: true });
const { base, github } = dev;
const { owner, admin, stranger } = SSO_USERS;
const mails = {
  reserved: { size: 40_000, to: "qa1@booth.pp.ua", id: "adm-reserved", subject: "reserved qa mail" },
  alice: { size: 30_000, to: "alice@booth.pp.ua", id: "adm-alice", subject: "alice mail" },
  bob: { size: 30_000, to: "bob@booth.pp.ua", id: "adm-bob", subject: "bob mail" },
};
const problems = [];
const deleted = new Set();
const EXPECTED = [
  (r) => r.status() === 401 && r.url().includes("/api/admin/"),
  (r) => r.status() === 403 && /\/api\/admin\/(admins(\/remove)?|audit)$/.test(r.url()),
  (r) => [400, 404].includes(r.status()) && r.url().endsWith("/api/admin/admins"),
  (r) => r.status() === 404 && /\/api\/admin\/messages\/[^/]+\/raw$/.test(r.url()) && deleted.has(r.url().split("/").at(-2)),
];

function watch(page) {
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("response", (r) => {
    if (r.status() >= 400 && !EXPECTED.some((match) => match(r))) problems.push(`${r.status()} ${r.url()}`);
  });
}

async function signIn(page, user) {
  github.signInAs(user.login);
  await page.goto(`${base}/admin`);
  await page.locator("#githubSignIn").waitFor({ state: "visible" });
  await page.click("#githubSignIn");
  await page.click("#authorize");
  await page.locator("#roleBadge").waitFor({ state: "visible" });
}

let browser;
try {
  for (const mail of Object.values(mails)) await probeIngest(base, dev.token, mail);

  const flat = async (url) => (await fetch(`${base}${url}`, { redirect: "manual" })).status;
  console.log(`serving: /admin=${await flat("/admin")} /admin/=${await flat("/admin/")} /admin.html=${await flat("/admin.html")}`);
  check("/admin is served as a page, not redirected", (await flat("/admin")) === 200);

  browser = await launchBrowser();
  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, acceptDownloads: true });
    const page = await context.newPage();
    watch(page);
    return page;
  };
  const ownerPage = await newPage();

  await ownerPage.goto(`${base}/admin`);
  await ownerPage.locator("#githubSignIn").waitFor({ state: "visible" });
  check("signed out: only the GitHub sign-in shows, with no password field", !(await ownerPage.locator("#app").isVisible()) && !(await ownerPage.locator("#logout").isVisible()) && (await ownerPage.locator("input[type=password]").count()) === 0 && /Sign in with GitHub/.test(await ownerPage.locator("#githubSignIn").innerText()));

  await signIn(ownerPage, owner);
  check("owner signs in through GitHub and the badge says Owner with the login", (await ownerPage.locator("#roleBadge").innerText()) === "Owner" && (await ownerPage.locator("#who").innerText()) === owner.login);
  check("owner sees the Mail, Admins and Audit tabs", (await ownerPage.locator("#sections a").allInnerTexts()).join(",") === "Mail,Admins,Audit");
  await ownerPage.locator("#rows tr").first().waitFor();
  check("owner's mail list shows every name's mail", (await ownerPage.locator("#rows tr").count()) === 3);

  await ownerPage.click('#sections a[href="#/admins"]');
  await ownerPage.locator("#adminForm").waitFor({ state: "visible" });
  await ownerPage.locator("#adminsEmpty").waitFor({ state: "visible" });
  check("Admins tab starts empty and names the owner ids as config", /Worker config/.test(await ownerPage.locator("#ownerIds").innerText()) && (await ownerPage.locator("#adminRows tr").count()) === 0);
  await ownerPage.fill("#adminLogin", "no-such-user-here");
  await ownerPage.click("#adminAdd");
  await ownerPage.locator("#adminsError").waitFor({ state: "visible" });
  check("an unknown GitHub user shows an inline error", /no GitHub user/.test(await ownerPage.locator("#adminsError").innerText()));
  await ownerPage.fill("#adminLogin", owner.login);
  await ownerPage.click("#adminAdd");
  await ownerPage.waitForFunction(() => /owners are set/.test(document.getElementById("adminsError").innerText));
  check("adding an owner is refused inline", (await ownerPage.locator("#adminRows tr").count()) === 0);
  await ownerPage.fill("#adminLogin", admin.login);
  await ownerPage.click("#adminAdd");
  await ownerPage.locator(`#adminRows tr[data-login="${admin.login}"]`).waitFor();
  check("adding an admin lists them and clears the error", !(await ownerPage.locator("#adminsError").isVisible()) && (await ownerPage.inputValue("#adminLogin")) === "");

  await ownerPage.click('#sections a[href="#/audit"]');
  await ownerPage.locator('#auditRows tr[data-action="admin_add"]').waitFor();
  check("the audit tab shows who added the admin", /sso-owner/.test(await ownerPage.locator('#auditRows tr[data-action="admin_add"]').innerText()));

  const adminPage = await newPage();
  await signIn(adminPage, admin);
  check("admin signs in and the badge says Admin", (await adminPage.locator("#roleBadge").innerText()) === "Admin" && (await adminPage.locator("#who").innerText()) === admin.login);
  check("admin has no Admins or Audit tab and no such panes in the page", (await adminPage.locator("#sections a").count()) === 0 && !(await adminPage.locator("#sections").isVisible()) && (await adminPage.locator("#adminsPane, #auditPane, #adminForm").count()) === 0);
  await adminPage.evaluate(() => { location.hash = "#/admins"; });
  await adminPage.locator("#rows tr").first().waitFor();
  check("opening the Admins address as an admin still shows only mail", (await adminPage.locator("#listPane").isVisible()) && (await adminPage.locator("#adminsPane").count()) === 0);
  await adminPage.evaluate(() => { location.hash = "#/"; });
  const statuses = await adminPage.evaluate(async () => {
    const get = async (path) => (await fetch(path)).status;
    const post = async (path, body) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin": "1" }, body: JSON.stringify(body) })).status;
    return [await get("/api/admin/admins"), await get("/api/admin/audit"), await post("/api/admin/admins", { login: "sso-stranger" }), await post("/api/admin/admins/remove", { github_id: 7002 })];
  });
  check("an admin is refused by every owner API", statuses.every((status) => status === 403), statuses.join(","));

  check("admin sees the list for every name", (await adminPage.locator("#rows tr").count()) === 3);
  check("admin sees the reserved-name mail with its recipient", (await adminPage.locator("#rows tr", { hasText: "qa1@booth.pp.ua" }).count()) === 1);
  const stats = await adminPage.locator("#stats").innerText();
  check("the stats bar shows the counts and sizes", /MESSAGES\s*3/i.test(stats) && /STORED MAIL/i.test(stats) && /400\.0 MB/.test(stats) && /D1 DATABASE\s*\d/i.test(stats), stats);

  await adminPage.fill("#search", "qa1");
  await adminPage.press("#search", "Enter");
  await adminPage.waitForFunction(() => document.querySelectorAll("#rows tr").length === 1);
  check("search narrows the list by recipient", (await adminPage.locator("#rows tr").innerText()).includes("reserved qa mail"));
  await adminPage.fill("#search", "");
  await adminPage.press("#search", "Enter");
  await adminPage.waitForFunction(() => document.querySelectorAll("#rows tr").length === 3);

  await adminPage.locator("#rows tr", { hasText: "reserved qa mail" }).locator("td").nth(4).click();
  await adminPage.locator("#preview").waitFor();
  check("opening a row routes to the message", /#\/m\/[A-Za-z0-9_-]+$/.test(adminPage.url()));
  check("the HTML view uses the inbox sandbox flags", (await adminPage.getAttribute("#preview", "sandbox")) === "allow-popups allow-popups-to-escape-sandbox");
  check("the HTML view renders the mail body", /Probe adm-reserved/.test(await adminPage.frameLocator("#preview").locator("h1").innerText()));
  await adminPage.click("[data-tab=text]");
  check("the Text tab shows the plain body", /Probe message adm-reserved/.test(await adminPage.locator("pre").innerText()));
  await adminPage.click("[data-tab=headers]");
  check("the Headers tab shows the stored header block", /To: qa1@booth\.pp\.ua/.test(await adminPage.locator("[data-raw-head]").innerText()));
  await adminPage.click("[data-tab=attachments]");
  check("the Attachments tab lists the PDF", /probe\.pdf/.test(await adminPage.locator(".list-group").innerText()));
  const download = adminPage.waitForEvent("download");
  await adminPage.click("#download");
  const file = await download;
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  check("Download .eml gives the stored bytes", file.suggestedFilename() === "message.eml" && sha(Buffer.concat(chunks)) === sha(buildMessage(mails.reserved)));

  await adminPage.click("#back");
  await adminPage.locator("#rows tr").first().waitFor();
  check("Back returns to the list", (await adminPage.locator("#rows tr").count()) === 3 && !(await adminPage.locator("#viewPane").isVisible()));

  const aliceId = await adminPage.evaluate(async () => (await (await fetch("/api/admin/messages?q=alice")).json()).messages[0].id);
  await adminPage.locator("#rows tr", { hasText: "alice mail" }).locator("input[type=checkbox]").check();
  await adminPage.locator("#rows tr", { hasText: "bob mail" }).locator("input[type=checkbox]").check();
  check("selecting rows enables Delete selected with a count", /\(2\)/.test(await adminPage.locator("#deleteSelected").innerText()) && (await adminPage.locator("#deleteSelected").isEnabled()));
  await adminPage.click("#deleteSelected");
  check("Delete selected asks for confirmation first", /Delete 2 messages permanently/.test(await adminPage.locator("#confirmText").innerText()) && (await adminPage.locator("#rows tr").count()) === 3);
  await adminPage.click("#confirmNo");
  check("Cancel keeps every message", !(await adminPage.locator("#confirm").isVisible()) && (await adminPage.locator("#rows tr").count()) === 3);
  deleted.add(aliceId);
  await adminPage.click("#deleteSelected");
  await adminPage.click("#confirmYes");
  await adminPage.waitForFunction(() => document.querySelectorAll("#rows tr").length === 1);
  check("confirming deletes only the selected messages", (await adminPage.locator("#rows tr").innerText()).includes("reserved qa mail"));
  await adminPage.waitForFunction(() => /MESSAGES\s*1/i.test(document.getElementById("stats").innerText));
  check("the stats bar updates after a delete", true);
  check("a deleted message is gone from the server", (await adminPage.evaluate(async (id) => (await fetch(`/api/admin/messages/${id}/raw`)).status, aliceId)) === 404);

  await ownerPage.click("#auditRefresh");
  await ownerPage.locator('#auditRows tr[data-action="delete"]').waitFor();
  const deleteRow = await ownerPage.locator('#auditRows tr[data-action="delete"]').innerText();
  check("the owner's audit tab shows the admin's delete with the count", deleteRow.includes(admin.login) && /2 messages/.test(deleteRow), deleteRow);

  await ownerPage.click('#sections a[href="#/admins"]');
  await ownerPage.locator(`#adminRows tr[data-login="${admin.login}"] [data-remove]`).click();
  check("removing an admin asks for confirmation first", /Remove sso-helper/.test(await ownerPage.locator("#adminConfirmText").innerText()) && (await ownerPage.locator("#adminRows tr").count()) === 1);
  await ownerPage.click("#adminConfirmNo");
  check("Cancel keeps the admin", !(await ownerPage.locator("#adminConfirm").isVisible()) && (await ownerPage.locator("#adminRows tr").count()) === 1);
  await ownerPage.locator(`#adminRows tr[data-login="${admin.login}"] [data-remove]`).click();
  await ownerPage.click("#adminConfirmYes");
  await ownerPage.locator("#adminsEmpty").waitFor({ state: "visible" });
  check("confirming removes the admin", (await ownerPage.locator("#adminRows tr").count()) === 0);

  await adminPage.click("#refresh");
  await adminPage.locator("#githubSignIn").waitFor({ state: "visible" });
  check("a removed admin is signed out on the next request with a message", /Your access ended/.test(await adminPage.locator("#loginError").innerText()) && !(await adminPage.locator("#app").isVisible()));

  await ownerPage.click('#sections a[href="#/audit"]');
  await ownerPage.locator('#auditRows tr[data-action="admin_remove"]').waitFor();
  check("the audit tab lists the add, the delete and the removal", (await ownerPage.locator("#auditRows tr").count()) === 3);

  const strangerPage = await newPage();
  github.signInAs(stranger.login);
  await strangerPage.goto(`${base}/admin`);
  await strangerPage.locator("#githubSignIn").waitFor({ state: "visible" });
  await strangerPage.click("#githubSignIn");
  await strangerPage.click("#authorize");
  await strangerPage.locator("#loginError").waitFor({ state: "visible" });
  check("an unlisted GitHub account lands back on the admin page with a not-authorised alert", /not authorised/.test(await strangerPage.locator("#loginError").innerText()) && new URL(strangerPage.url()).pathname === "/admin");
  check("and the sign-in reason is removed from the address bar", new URL(strangerPage.url()).search === "");
  check("and stays signed out", (await strangerPage.evaluate(async () => (await fetch("/api/admin/stats")).status)) === 401);

  for (const [name, setup, expected] of [["a GitHub exchange failure", () => { github.state.failToken = true; }, /GitHub settings may be wrong/], ["a cancelled consent", () => { github.state.deny = true; }, /cancelled/]]) {
    const failPage = await newPage();
    github.signInAs(owner.login);
    setup();
    await failPage.goto(`${base}/admin`);
    await failPage.locator("#githubSignIn").waitFor({ state: "visible" });
    await failPage.click("#githubSignIn");
    await failPage.click("#authorize");
    await failPage.locator("#loginError").waitFor({ state: "visible" });
    check(`${name} lands back on the admin page with an alert and no session`, expected.test(await failPage.locator("#loginError").innerText()) && new URL(failPage.url()).search === "" && !(await failPage.locator("#app").isVisible()));
    github.state.failToken = false;
    github.state.deny = false;
  }

  await ownerPage.click("#logout");
  await ownerPage.locator("#githubSignIn").waitFor({ state: "visible" });
  await ownerPage.reload();
  await ownerPage.locator("#githubSignIn").waitFor({ state: "visible" });
  check("after sign out the admin API refuses the browser and the sign-in returns", (await ownerPage.evaluate(async () => (await fetch("/api/admin/stats")).status)) === 401 && (await ownerPage.locator("#adminsPane, #auditPane").count()) === 0);
  check("no script errors or unexpected failed requests", problems.length === 0, problems.join(" | "));
} finally {
  await browser?.close();
  await dev.stop();
}
console.log(failures ? `admin browser check: ${failures} FAILED` : "admin browser check: all checks passed");
process.exit(failures ? 1 : 0);
