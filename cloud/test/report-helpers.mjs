import crypto from "node:crypto";
import { startDev } from "./dev-server.mjs";

export const TURNSTILE_TEST = {
  siteKey: "1x00000000000000000000AA",
  passSecret: "1x0000000000000000000000000000000AA",
  failSecret: "2x0000000000000000000000000000000AA",
  token: "XXXX.DUMMY.TOKEN.XXXX",
};
export const png = (extra = 0) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(100 + extra)]);

export async function withReportDev({ port: devPort, secret = TURNSTILE_TEST.passSecret, siteKey = TURNSTILE_TEST.siteKey, github }, run) {
  const githubPort = await github.listen();
  const dev = await startDev({
    port: devPort,
    vars: {
      ISSUES_REPO: github.reportsRepo,
      GITHUB_ISSUES_TOKEN: github.issuesToken,
      GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
      ...(siteKey ? { TURNSTILE_SITE_KEY: siteKey } : {}),
      ...(secret ? { TURNSTILE_SECRET: secret } : {}),
    },
  });
  try {
    return await run(dev);
  } finally {
    await dev.stop();
    await github.close();
  }
}

export function reportForm(images, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ category: "bug", title: "Integration report", details: "details from the integration test", ...fields })) form.append(key, value);
  images.forEach((bytes, i) => form.append("images", new Blob([bytes], { type: "image/png" }), `shot-${i + 1}.png`));
  return form;
}

export const call = (base, path, { method = "GET", token, body, headers = {} } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { ...(token ? { "X-Turnstile-Token": token } : {}), ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers },
  body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
});

