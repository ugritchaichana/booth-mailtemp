export const TARGET_URL = "https://mail.booth.pp.ua/";

export const handle = () => new Response(null, { status: 302, headers: { Location: TARGET_URL, "Cache-Control": "no-store" } });

export default { fetch: () => handle() };
