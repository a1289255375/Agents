import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const newToken = () => randomBytes(32).toString("base64url");

// Credential for the shell-wait endpoint. It is derived from the token instead of stored, so the curl
// command an agent already holds keeps working after this service restarts. It only allows waiting
// for messages of that one session; the token itself never has to reach the cloud VM.
export function waitTicket(token, sessionId) {
  return `wt_${createHmac("sha256", token).update(`wait:${sessionId}`).digest("base64url").slice(0, 32)}`;
}

export function hasBearer(req, expected) {
  const given = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!given) return false;
  // Hashing first gives equal lengths, which timingSafeEqual requires.
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
