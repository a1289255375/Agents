import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const newToken = () => randomBytes(32).toString("base64url");

export function hasBearer(req, expected) {
  const given = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!given) return false;
  // Hashing first gives equal lengths, which timingSafeEqual requires.
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
