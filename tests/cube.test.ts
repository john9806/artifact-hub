import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import type { Artifact } from "../shared/model.js";
import { queryCube } from "../server/cube.js";
import { config } from "./helpers.js";

test("Cube proxy supplies server-derived identity and never returns its token; caps response size and surfaces query failures", async () => {
  let mode = "normal";
  let token = "";
  let body = "";
  const server = createServer((request, response) => {
    token = request.headers.authorization ?? "";
    body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (mode === "large") response.end(JSON.stringify({ data: "x".repeat(2_000_001) }));
      else if (mode === "error") response.end(JSON.stringify({ error: "Continue wait" }));
      else response.end(JSON.stringify({ data: [{ "Orders.count": "42" }] }));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const settings = { ...config, cubeUrl: `http://127.0.0.1:${address.port}/cubejs-api/v1`, cubeSecret: "test-cube-secret" };
  const artifact: Artifact = {
    id: randomUUID(), title: "Test", description: "", html: "", owner: "alice", updatedBy: "alice",
    updatedAt: new Date().toISOString(), allowedMembers: ["Orders.count"], digest: "a".repeat(64), revision: "a".repeat(40),
  };
  try {
    const data = await queryCube(settings, artifact, { login: "alice", canWrite: true, canReview: false }, { measures: ["Orders.count"] });
    assert.deepEqual(data, { data: [{ "Orders.count": "42" }] });
    const [header, payload, signature] = token.split(".");
    assert.equal(signature, createHmac("sha256", settings.cubeSecret).update(`${header}.${payload}`).digest("base64url"));
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.equal(claims.githubLogin, "alice");
    assert.equal(claims.artifactId, artifact.id);
    assert.equal(JSON.parse(body).query.limit, 100);
    assert.ok(!JSON.stringify(data).includes(token));
    mode = "error";
    await assert.rejects(() => queryCube(settings, artifact, { login: "alice", canWrite: true, canReview: false }, { measures: ["Orders.count"] }), /Try again/);
    mode = "large";
    await assert.rejects(() => queryCube(settings, artifact, { login: "alice", canWrite: true, canReview: false }, { measures: ["Orders.count"] }), /2 MB/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
