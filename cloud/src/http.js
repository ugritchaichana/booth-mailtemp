export const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
});

export const fail = (status, error) => json(status, { error });
