const USERNAME_RE = /^([a-z0-9][a-z0-9._-]{2,29})(?:\+[a-z0-9._-]{1,30})?$/;
const RESERVED = new Set(["root", "admin", "postmaster", "abuse", "hostmaster", "webmaster", "noreply", "no-reply", "security", "support", "mailer-daemon"]);

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const usernameError = (name) => {
  const base = USERNAME_RE.exec(name)?.[1];
  if (!base) return "username must be 3-30 chars: a-z 0-9 . _ - (optionally +tag, 1-30 chars)";
  return base.startsWith("qa") || base.startsWith("h13") || RESERVED.has(base) ? "username not available" : null;
};

export function ownsRecipient(username, recipient, domain) {
  const mail = String(recipient).toLowerCase();
  const at = mail.lastIndexOf("@");
  const local = mail.slice(0, at);
  return at > 0 && mail.slice(at + 1) === domain && (local === username || local.startsWith(`${username}+`));
}

export const ownershipArgs = (username) => [username, `${username}+`, `${username},`];

export const OWNS_SQL = "(r.local = ? OR (r.local >= ? AND r.local < ?))";
