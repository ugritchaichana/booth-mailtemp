import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { launchBrowser } from "./browser.mjs";
import { startDev } from "./dev-server.mjs";
import { createFakeGithub } from "./fake-github.mjs";
import { TURNSTILE_TEST, withReportDev } from "./report-helpers.mjs";

const port = Number(process.env.PORT ?? 8796);
const stubWidget = process.env.TURNSTILE_WIDGET === "stub";
const shots = process.env.SHOTS_DIR;
const WIDGET_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js*";
const WIDGET_STUB = `window.turnstile = { render(el, opts) { setTimeout(() => opts.callback(${JSON.stringify(TURNSTILE_TEST.token)}), 20); return "stub"; }, remove() {} };`;
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const ZWSP = String.fromCharCode(0x200b);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

function png(width, height) {
  const row = Buffer.alloc(1 + width * 3);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * row.length;
    for (let x = 0; x < width; x += 1) raw.writeUIntBE(((x * 255 / width) << 16) | ((y * 255 / height) << 8) | ((x + y) & 255), at + 1 + x * 3, 3);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function jpegSize(bytes) {
  for (let i = 2; i < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

const upload = (name, buffer, mimeType) => ({ name, mimeType, buffer });
const EXPECTED = [
  (r) => r.status() === 401 && r.url().endsWith("/api/me"),
  (r) => r.status() === 403 && /\/api\/(random|open)$/.test(r.url()),
  (r) => r.status() === 429 && r.url().endsWith("/api/report"),
];

async function run(dev, github, browser) {
  const { base } = dev;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  if (stubWidget) await page.route(WIDGET_URL, (route) => route.fulfill({ contentType: "text/javascript", body: WIDGET_STUB }));
  const problems = [];
  const sent = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400 && !EXPECTED.some((match) => match(r))) problems.push(`${r.status()} ${r.url()}`); });
  page.on("request", (r) => { if (/\/api\/(open|random|report)$/.test(new URL(r.url()).pathname)) sent.push({ path: new URL(r.url()).pathname, token: r.headers()["x-turnstile-token"] }); });
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const openReport = async () => { await page.locator("#navList [data-report=open]:visible, #navView [data-report=open]:visible").first().click(); await page.locator("#reportModal.d-block").waitFor(); };

  await page.goto(`${base}/`);
  await page.locator("#spot:not(.d-none)").waitFor();
  const reportButton = page.locator("#navList [data-report=open]");
  await reportButton.waitFor({ state: "visible" });
  check("with no address the spotlight is up and the Report a problem button is visible", (await reportButton.isVisible()) && (await page.locator("#spot").isVisible()));

  await openReport();
  check("the report button works above the spotlight and opens the modal", await page.locator("#reportModal").isVisible());
  const box = await page.locator("#reportModal .modal-content").boundingBox();
  const viewport = page.viewportSize();
  check("the modal is centred on the screen", Math.abs(box.x + box.width / 2 - viewport.width / 2) < 4 && Math.abs(box.y + box.height / 2 - viewport.height / 2) < 4, JSON.stringify(box));
  await shot("report-empty");
  await page.keyboard.press("Escape");
  check("Escape closes the report modal and leaves the page usable", !(await page.locator("#reportModal").isVisible()) && (await page.evaluate(() => document.querySelector("#app").inert === false)));

  await page.locator("#spot:not(.d-none)").waitFor();
  await page.locator("[data-act=add]:visible").first().click();
  await page.locator("#addModal.d-block").waitFor();
  check("the add-address modal offers the report link", await page.locator("#addModal [data-report=open]").isVisible());
  await page.locator("#randomBtn").click();
  await page.waitForFunction(() => /^rand-[a-z0-9]{6}$/.test(document.querySelector("#user").value));
  const generated = await page.inputValue("#user");
  const name = `browser-${Date.now().toString(36)}`;
  await page.fill("#user", name);
  await page.click("#go");
  await page.locator("#sideList [data-addr]").filter({ hasText: `${name}@booth.pp.ua` }).waitFor();
  check("random and Open inbox each sent a Turnstile token and the inbox opened", generated.startsWith("rand-") && sent.filter((s) => s.path === "/api/random").length === 1 && sent.filter((s) => s.path === "/api/open").length === 1 && sent.every((s) => s.token === TURNSTILE_TEST.token), JSON.stringify(sent));

  const rejects = await page.evaluate(async () => [(await fetch("/api/random")).status, (await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "script-made" }) })).status]);
  check("a script without a token is refused by the server", rejects.join() === "403,403", rejects.join());

  await openReport();
  await page.fill("#rTitle", "   ");
  await page.click("#rSubmit");
  check("client-side validation shows a message and sends nothing", /Enter a title/.test(await page.locator("#reportErr").innerText()) && !sent.some((s) => s.path === "/api/report"));
  await page.selectOption("#rCategory", "problem");
  await page.fill("#rTitle", "Inbox is slow to load");
  await page.fill("#rDetails", "It took a minute.\nSecond line, cc @someone");
  await page.fill("#rFrom", "2026-10-19T14:30");
  await page.fill("#rTo", "2026-10-19T14:10");
  await page.click("#rSubmit");
  check("a start time after the end time is refused in the browser", /start time is after/.test(await page.locator("#reportErr").innerText()));
  await page.fill("#rTo", "2026-10-19T15:00");

  const large = png(3000, 1500);
  await page.setInputFiles("#rFile", [upload("large.png", large, "image/png"), upload("small.png", png(120, 80), "image/png"), upload("dot.gif", GIF, "image/gif")]);
  await page.waitForFunction(() => document.querySelectorAll("#rPreviews [data-image]").length === 3);
  check("three previews appear with the counter at 3 / 20", (await page.locator("#rImageCount").innerText()) === "3 / 20");
  await page.waitForFunction(() => [...document.querySelectorAll("#rPreviews img")].every((img) => img.complete && img.naturalWidth > 0));
  const tiles = await page.evaluate(() => [...document.querySelectorAll("#rPreviews [data-image]")].map((tile) => ({ natural: tile.querySelector("img").naturalWidth, shown: tile.querySelector("img").getBoundingClientRect().width, button: tile.querySelector("[data-remove]").getBoundingClientRect().width })));
  check("each preview shows its picture with a small remove button", tiles.every((t) => t.natural > 0 && t.shown > 60 && t.button < 40), JSON.stringify(tiles));
  await page.locator("#rPreviews").scrollIntoViewIfNeeded();
  await shot("report-filled");
  await page.locator('#rPreviews [data-image] [data-remove]').nth(1).click();
  check("removing an image leaves two previews and the counter at 2 / 20", (await page.locator("#rPreviews [data-image]").count()) === 2 && (await page.locator("#rImageCount").innerText()) === "2 / 20");

  await page.route("**/api/report", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many reports, try again later" }) }));
  await page.click("#rSubmit");
  await page.locator("#reportErr:not(.d-none)").waitFor();
  check("a server error is shown in the modal and the draft is kept", /Too many reports, try again later\./.test(await page.locator("#reportErr").innerText()) && (await page.inputValue("#rTitle")) === "Inbox is slow to load" && (await page.locator("#rPreviews [data-image]").count()) === 2 && (await page.locator("#reportModal").isVisible()));
  await page.unroute("**/api/report");

  await page.click("#rSubmit");
  await page.locator("#reportDone:not(.d-none)").waitFor();
  check("success shows the report number", /Report #1 received/.test(await page.locator("#reportDone").innerText()));
  await shot("report-done");
  const { repo } = github;
  const [issue] = repo.issues;
  const files = repo.trees.get(repo.commits.get(repo.head).tree);
  const stored = [...files.entries()].map(([p, sha]) => ({ path: p, bytes: repo.blobs.get(sha) }));
  check("the issue was filed with the title, labels and details", issue?.title === "[problem] Inbox is slow to load" && issue.labels.join() === "report,report:problem" && issue.body.includes(`Second line, cc @${ZWSP}someone`), JSON.stringify(issue)?.slice(0, 300));
  check("the issue names the address, the page and the time range in Bangkok time", issue.body.includes(`- Address: \`${name}@booth.pp.ua\``) && /- Page: `#\/`/.test(issue.body) && /\*\*When:\*\* .* Asia\/Bangkok/.test(issue.body), issue.body);
  check("exactly the two kept images were committed and linked", stored.length === 2 && (issue.body.match(/!\[image \d\]/g) ?? []).length === 2, String(stored.length));
  const compressed = stored.find((s) => s.path.endsWith(".jpg"));
  if (shots) fs.writeFileSync(path.join(shots, "compressed.jpg"), compressed.bytes);
  check("the 3000 px screenshot was compressed to a jpeg with a 2000 px long edge", compressed && jpegSize(compressed.bytes)?.join("x") === "2000x1000" && compressed.bytes.length < large.length, compressed && String(jpegSize(compressed.bytes)));
  check("the gif was uploaded byte for byte unchanged", stored.some((s) => s.path.endsWith(".gif") && s.bytes.equals(GIF)));
  check("the report request carried the Turnstile token", sent.filter((s) => s.path === "/api/report").every((s) => s.token === TURNSTILE_TEST.token) && sent.some((s) => s.path === "/api/report"));

  await page.click("#rDoneClose");
  check("closing after success resets the form", !(await page.locator("#reportModal").isVisible()));
  await openReport();
  check("the reopened form is empty", (await page.inputValue("#rTitle")) === "" && (await page.locator("#rPreviews [data-image]").count()) === 0 && (await page.locator("#rImageCount").innerText()) === "0 / 20");

  await page.evaluate(async () => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    document.querySelector("#reportModal").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    const pasted = new DataTransfer();
    pasted.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pasted, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll("#rPreviews [data-image]").length === 2);
  check("a dropped image and a pasted image both become previews", true);
  await page.locator("#rTitle").focus();
  await page.evaluate(() => document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: Object.assign(new DataTransfer(), {}), bubbles: true, cancelable: true })));
  check("pasting with no image leaves the form alone", (await page.locator("#rPreviews [data-image]").count()) === 2);

  const tiny = png(8, 8);
  await page.setInputFiles("#rFile", Array.from({ length: 19 }, (_, i) => upload(`tiny-${i}.png`, tiny, "image/png")));
  await page.waitForFunction(() => /Only 20 images/.test(document.querySelector("#rImageNote").innerText));
  check("the twenty-first image is refused with a note", (await page.locator("#rPreviews [data-image]").count()) === 20 && (await page.locator("#rImageCount").innerText()) === "20 / 20");
  await page.keyboard.press("Escape");
  check("Escape closes the modal and the draft survives a reopen", !(await page.locator("#reportModal").isVisible()));
  await openReport();
  check("the draft and its twenty images are still there", (await page.locator("#rPreviews [data-image]").count()) === 20);
  for (let i = 0; i < 20; i += 1) await page.locator("#rPreviews [data-image] [data-remove]").first().click();
  await page.keyboard.press("Escape");

  await page.locator("[data-act=add]:visible").first().click();
  await page.locator("#addModal.d-block").waitFor();
  await page.locator("#addModal [data-report=open]").click();
  await page.locator("#reportModal.d-block").waitFor();
  await page.keyboard.press("Escape");
  const stack = await page.evaluate(() => ({ add: getComputedStyle(document.querySelector("#addModal")).display, report: getComputedStyle(document.querySelector("#reportModal")).display, addInert: document.querySelector("#addModal").inert, appInert: document.querySelector("#app").inert }));
  check("the report modal opens over the add modal and returns to it on close", stack.add === "block" && stack.report === "none" && !stack.addInert && stack.appInert, JSON.stringify(stack));
  await page.keyboard.press("Escape");

  check("the inbox stays usable after all of that", !(await page.evaluate(() => document.querySelector("#app").inert)) && (await page.locator("#sideList [data-addr]").innerText()).includes(name));

  const mobile = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  const phone = await mobile.newPage();
  if (stubWidget) await phone.route(WIDGET_URL, (route) => route.fulfill({ contentType: "text/javascript", body: WIDGET_STUB }));
  await phone.goto(`${base}/`);
  await phone.locator("#spot:not(.d-none)").waitFor();
  await phone.locator("#offBody [data-act=add]").click();
  await phone.locator("#addModal.d-block").waitFor();
  await phone.locator("#addModal [data-report=open]").click();
  await phone.locator("#reportModal.d-block").waitFor();
  const phoneBox = await phone.locator("#reportModal .modal-content").boundingBox();
  check("on a phone the modal fits the width", phoneBox.x >= 0 && phoneBox.x + phoneBox.width <= 390, JSON.stringify(phoneBox));
  if (shots) await phone.screenshot({ path: path.join(shots, "report-phone.png") });
  await mobile.close();

  check("no page errors and no unexpected failed requests", problems.length === 0, problems.join(" | "));
}

async function unconfigured(browser) {
  const github = createFakeGithub();
  await withReportDev({ port, github, secret: "", siteKey: "" }, async ({ base }) => {
    const page = await (await browser.newContext()).newPage();
    const widgetRequests = [];
    const errors = [];
    page.on("request", (r) => { if (r.url().includes("challenges.cloudflare.com")) widgetRequests.push(r.url()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/`);
    await page.locator("#spot:not(.d-none)").waitFor();
    await page.locator("[data-act=add]:visible").first().click();
    await page.fill("#user", "no-widget");
    await page.click("#go");
    await page.locator("#sideList [data-addr]").filter({ hasText: "no-widget@booth.pp.ua" }).waitFor();
    check("with Turnstile unset the address opens without loading any widget", widgetRequests.length === 0 && errors.length === 0, `${widgetRequests} ${errors}`);
  });

  const none = createFakeGithub();
  const noneRepo = await none.listen();
  const dev = await startDev({ port, vars: { GITHUB_API_BASE: `http://127.0.0.1:${noneRepo}` } });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${dev.base}/`);
    await page.locator("#spot:not(.d-none)").waitFor();
    await page.waitForTimeout(500);
    check("with the report config unset the Report a problem button is hidden", (await page.locator("[data-report=open]:visible").count()) === 0);
  } finally {
    await dev.stop();
    await none.close();
  }
}

let browser;
try {
  browser = await launchBrowser();
  const github = createFakeGithub();
  await withReportDev({ port, github }, (dev) => run(dev, github, browser));
  await unconfigured(browser);
} catch (err) {
  console.log(`FAIL  ${err.stack ?? err}`);
  failures += 1;
} finally {
  await browser?.close();
}
console.log(failures ? `${failures} check(s) failed` : "report browser: all checks passed");
process.exit(failures ? 1 : 0);
