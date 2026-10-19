import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

function cachedChromiumPaths() {
  if (process.env.CHROMIUM_PATH) return [process.env.CHROMIUM_PATH];
  const cache = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (!fs.existsSync(cache)) return [];
  const builds = fs.readdirSync(cache).filter((d) => /^chromium-[0-9]+$/.test(d)).sort().reverse();
  return builds.map((d) => path.join(cache, d, "chrome-win64", "chrome.exe")).filter((p) => fs.existsSync(p));
}

export async function launchBrowser() {
  let lastError;
  for (const executablePath of [undefined, ...cachedChromiumPaths()]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
