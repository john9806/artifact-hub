import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export function signToken(secret: string, payload: object, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifyToken(secret: string, token: string): unknown {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;
  const actual = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }
  const expiry = z.object({ exp: z.number() }).safeParse(value);
  if (!expiry.success || expiry.data.exp <= Date.now() / 1000) return null;
  return value;
}
