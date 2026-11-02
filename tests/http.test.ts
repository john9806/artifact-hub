import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createApps } from "../server/app.js";
import { signToken } from "../server/tokens.js";
import { config, fixture } from "./helpers.js";

test("HTTP enforces authentication, roles, CSRF, immutable previews and separate render surface", async () => {
  const f = await fixture();
  const server = createServer().listen(0, "127.0.0.1");
  const renderer = createServer().listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(renderer, "listening")]);
  const address = server.address();
  const renderAddress = renderer.address();
  assert.ok(address && typeof address !== "string" && renderAddress && typeof renderAddress !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const renderBase = `http://127.0.0.1:${renderAddress.port}`;
  const settings = { ...config, appOrigin: base, artifactOrigin: renderBase };
  const { app, artifacts } = createApps(settings, f.library);
  server.on("request", app);
  renderer.on("request", artifacts);
  const token = (login: string) => `artifact_hub_session=${signToken(config.secret, { kind: "session", login }, 600)}`;
  async function request(url: string, method = "GET", body?: unknown, login?: string, origin = base) {
    return fetch(base + url, {
      method,
      headers: {
        ...(login ? { Cookie: token(login) } : {}),
        ...(method !== "GET" ? { "Content-Type": "application/json", Origin: origin, "X-Artifact-Hub": "1" } : {}),
      },
      body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    });
  }
  try {
    assert.equal((await request("/api/artifacts")).status, 401);
    assert.equal((await request("/api/artifacts", "GET", undefined, "mallory")).status, 403);
    assert.equal((await request("/api/artifacts", "POST", {}, "bob")).status, 403);
    assert.equal((await request("/api/artifacts", "POST", {}, "alice", "https://attacker.example")).status, 403);
    const body = { title: "Pricing", description: "", html: "<h1>Preview</h1>", allowedMembers: [], expectedRevision: null };
    const savedResponse = await request("/api/artifacts", "POST", body, "alice");
    assert.equal(savedResponse.status, 201);
    const saved = await savedResponse.json() as { id: string; revision: string };
    const sourceUrl = `/api/artifacts/${saved.id}/source?revision=${saved.revision}`;
    assert.equal((await request(sourceUrl)).status, 401);
    const source = await request(sourceUrl, "GET", undefined, "bob");
    assert.equal(source.status, 200);
    assert.match(source.headers.get("content-disposition") ?? "", new RegExp(`^attachment; filename="artifact-${saved.id}-[a-f0-9]{12}\\.html"$`));
    assert.match(source.headers.get("content-type") ?? "", /^text\/plain; charset=utf-8$/);
    assert.equal(source.headers.get("x-content-type-options"), "nosniff");
    assert.equal(source.headers.get("cache-control"), "no-store");
    assert.equal(await source.text(), body.html);
    assert.equal((await request(`/api/artifacts/${saved.id}/source`, "GET", undefined, "alice")).status, 422);
    const revisedHtml = "<h1>Revised by Claude / 日本語</h1>\n\n";
    const editedResponse = await request(`/api/artifacts/${saved.id}`, "PUT", {
      ...body, html: revisedHtml, expectedRevision: saved.revision,
    }, "alice");
    assert.equal(editedResponse.status, 200);
    const edited = await editedResponse.json() as { id: string; owner: string; revision: string };
    assert.equal(edited.id, saved.id);
    assert.equal(edited.owner, "alice");
    assert.equal((await (await request(sourceUrl, "GET", undefined, "alice")).text()), body.html);
    assert.equal(await (await request(`/api/artifacts/${saved.id}/source?revision=${edited.revision}`, "GET", undefined, "alice")).text(), revisedHtml);
    assert.equal((await request(`/api/artifacts/${saved.id}`, "PUT", { ...body, expectedRevision: saved.revision }, "alice")).status, 409);
    assert.equal((await (await request("/api/artifacts", "GET", undefined, "alice")).json()).length, 1);
    await assert.rejects(() => f.library.current(saved.id, "prod"), /not found/);
    saved.revision = edited.revision;
    const previewResponse = await request(`/api/artifacts/${saved.id}/preview`, "POST", { environment: "dev", expectedRevision: saved.revision }, "alice");
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { url: string };
    const renderPath = new URL(preview.url).pathname + new URL(preview.url).search;
    const headers = { "Sec-Fetch-Dest": "iframe" };
    const rendered = await fetch(renderBase + renderPath, { headers });
    assert.equal(rendered.status, 200);
    assert.match(rendered.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
    assert.equal(rendered.headers.get("set-cookie"), null);
    assert.ok((await rendered.text()).includes(revisedHtml));
    assert.equal((await fetch(renderBase + renderPath)).status, 403);
    assert.equal((await fetch(renderBase + "/api/artifacts", { headers })).status, 404);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + "/health", { headers: { Host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(wrongHost, 421);
    assert.equal((await request(`/api/artifacts/${saved.id}/preview`, "POST", { environment: "dev", expectedRevision: "a".repeat(40) }, "alice")).status, 409);
    assert.equal((await request(`/api/artifacts/${saved.id}/query`, "POST", { source: { revision: saved.revision }, query: { measures: ["Orders.count"] } }, "alice")).status, 503);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => renderer.close((error) => error ? reject(error) : resolve())),
    ]);
    await f.close();
  }
});
