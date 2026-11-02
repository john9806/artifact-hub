import { createHmac } from "node:crypto";
import { z } from "zod";
import { memberSchema, type Artifact, type User } from "../shared/model.js";
import { type Config } from "./config.js";
import { HttpError } from "./errors.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const cubeQuerySchema = z.object({
  measures: z.array(memberSchema).max(20).optional(),
  dimensions: z.array(memberSchema).max(20).optional(),
  timeDimensions: z.array(z.object({
    dimension: memberSchema,
    granularity: z.enum(["second", "minute", "hour", "day", "week", "month", "quarter", "year"]).optional(),
    dateRange: z.tuple([date, date]).optional(),
  }).strict()).max(5).optional(),
  filters: z.array(z.object({
    member: memberSchema,
    operator: z.enum(["equals", "notEquals", "contains", "notContains", "gt", "gte", "lt", "lte", "set", "notSet"]),
    values: z.array(z.string().max(200)).max(30).optional(),
  }).strict()).max(20).optional(),
  order: z.record(memberSchema, z.enum(["asc", "desc"])).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
}).strict();

export function validateCubeQuery(raw: unknown, artifact: Pick<Artifact, "allowedMembers">, globalMembers: string[]) {
  const query = cubeQuerySchema.parse(raw);
  if (!(query.measures?.length || query.dimensions?.length || query.timeDimensions?.length)) {
    throw new HttpError(422, "A query needs a measure or dimension.");
  }
  const members = [
    ...(query.measures ?? []), ...(query.dimensions ?? []),
    ...(query.timeDimensions ?? []).map((value) => value.dimension),
    ...(query.filters ?? []).map((value) => value.member),
    ...Object.keys(query.order ?? {}),
  ];
  if (members.some((member) => !artifact.allowedMembers.includes(member) || !globalMembers.includes(member))) {
    throw new HttpError(403, "Query references a Cube member not granted to this artifact.");
  }
  if (Object.keys(query.order ?? {}).length > 20) throw new HttpError(422, "Too many sort members.");
  return query;
}

export async function queryCube(config: Config, artifact: Artifact, user: User, raw: unknown): Promise<unknown> {
  if (!config.cubeUrl || !config.cubeSecret) throw new HttpError(503, "Cube is not configured.");
  const query = validateCubeQuery(raw, artifact, config.cubeMembers);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now, exp: now + 60,
    githubLogin: user.login, artifactId: artifact.id,
  })).toString("base64url");
  const token = `${header}.${payload}.${createHmac("sha256", config.cubeSecret).update(`${header}.${payload}`).digest("base64url")}`;
  const response = await fetch(`${config.cubeUrl}/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok) {
    console.error("Cube query failed", { status: response.status, artifact: artifact.id, actor: user.login });
    throw new HttpError(502, `Cube rejected the query (${response.status}).`);
  }
  if (!response.body) throw new HttpError(502, "Cube returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 2_000_000) {
      await reader.cancel();
      throw new HttpError(502, "Cube result exceeded the 2 MB response limit.");
    }
    chunks.push(next.value);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const failure = z.object({ error: z.string() }).safeParse(data);
  if (failure.success) throw new HttpError(502, failure.data.error === "Continue wait" ? "Cube is preparing this query. Try again shortly." : "Cube reported a query error. Check server-side Cube logs.");
  return data;
}
