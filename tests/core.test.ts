import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../server/config.js";
import { signToken, verifyToken } from "../server/tokens.js";
import { validateCubeQuery } from "../server/cube.js";
import { artifactCsp, frameDocument } from "../server/frame.js";
import { reviewDecision } from "../server/github.js";
import { MAX_HTML_BYTES, inputSchema } from "../shared/model.js";
import { config } from "./helpers.js";

test("configuration requires separate HTTPS hosts, explicit access, and disallows production local login", () => {
  const env = {
    SESSION_SECRET: config.secret, GITHUB_REPOSITORY: config.repository, GITHUB_TOKEN: "test",
    APP_ORIGIN: "https://hub.example.com", ARTIFACT_ORIGIN: "https://untrusted.example.net",
    GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret", GITHUB_ALLOWED_USERS: "alice,bob",
    GITHUB_WRITERS: "alice", GITHUB_REVIEWERS: "bob",
  };
  assert.equal(loadConfig(env).reviewers[0], "bob");
  assert.throws(() => loadConfig({ ...env, ARTIFACT_ORIGIN: "https://hub.example.com:3001" }), /different hostnames/);
  assert.throws(() => loadConfig({ ...env, APP_ORIGIN: "http://hub.example.com" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, GITHUB_ALLOWED_USERS: "" }), /allowlist/);
  assert.throws(() => loadConfig({ ...env, LOCAL_DEVELOPMENT: "true", NODE_ENV: "production" }), /cannot be enabled/);
  assert.throws(() => loadConfig({ ...env, GITHUB_WRITERS: "mallory" }), /missing/);
  assert.throws(() => loadConfig({ ...env, CUBE_API_URL: "https://cube.example.com" }), /both/);
});

test("signed capabilities reject tampering, malformed payloads, and expiry", () => {
  const token = signToken(config.secret, { kind: "test", id: randomUUID() }, 60);
  assert.equal(typeof verifyToken(config.secret, token), "object");
  assert.equal(verifyToken("another-secret", token), null);
  assert.equal(verifyToken(config.secret, token + ".extra"), null);
  assert.equal(verifyToken(config.secret, "not-a-token"), null);
  assert.equal(verifyToken(config.secret, signToken(config.secret, { kind: "test" }, -1)), null);
});

test("only current-head independent approvals count; change requests and dismissals block publication", () => {
  const head = "a".repeat(40);
  const reviews = [
    { id: 1, user: { login: "alice" }, state: "APPROVED", commit_id: head },
    { id: 2, user: { login: "bob" }, state: "APPROVED", commit_id: "b".repeat(40) },
  ];
  assert.equal(reviewDecision(reviews, head, ["alice", "bob"], "alice").approvals.length, 0);
  reviews.push({ id: 3, user: { login: "Bob" }, state: "APPROVED", commit_id: head });
  assert.deepEqual(reviewDecision(reviews, head, ["bob"], "alice").approvals, ["bob"]);
  reviews.push({ id: 4, user: { login: "bob" }, state: "COMMENTED", commit_id: head });
  assert.deepEqual(reviewDecision(reviews, head, ["bob"], "alice").approvals, ["bob"]);
  reviews.push({ id: 5, user: { login: "bob" }, state: "DISMISSED", commit_id: head });
  assert.equal(reviewDecision(reviews, head, ["bob"], "alice").approvals.length, 0);
  reviews.push({ id: 6, user: { login: "bob" }, state: "CHANGES_REQUESTED", commit_id: head });
  assert.match(reviewDecision(reviews, head, ["bob"], "alice").blockers.join(" "), /requested changes/);
});

test("Cube grants constrain every query surface, cap rows, reject SQL and unknown keys", () => {
  const grants = { allowedMembers: config.cubeMembers };
  assert.equal(validateCubeQuery({ measures: ["Orders.count"] }, grants, config.cubeMembers).limit, 100);
  const denied = [
    { measures: ["Private.secret"] },
    { measures: ["Orders.count"], filters: [{ member: "Private.secret", operator: "equals", values: ["x"] }] },
    { measures: ["Orders.count"], order: { "Private.secret": "asc" } },
    { measures: ["Orders.count"], timeDimensions: [{ dimension: "Private.secret" }] },
    { measures: ["Orders.count"], limit: 1001 },
    { measures: ["Orders.count"], sql: "select * from secrets" },
    { measures: ["Orders.count"], filters: [{ member: "Orders.region", operator: "expression" }] },
    {},
  ];
  for (const query of denied) assert.throws(() => validateCubeQuery(query, grants, config.cubeMembers));
  assert.throws(() => validateCubeQuery({ measures: ["Orders.count"] }, { allowedMembers: [] }, config.cubeMembers));
});

test("artifact CSP forbids same-origin, network, frames, forms, workers and eval", () => {
  const csp = artifactCsp(config.appOrigin);
  for (const rule of ["sandbox allow-scripts", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "worker-src 'none'", "base-uri 'none'"]) assert.ok(csp.includes(rule));
  assert.ok(!csp.includes("allow-same-origin"));
  assert.ok(!csp.includes("unsafe-eval"));
  const html = frameDocument("<script>console.log('untrusted')</script>", config.appOrigin);
  assert.ok(html.indexOf("artifactHub") < html.indexOf("console.log"));
  assert.ok(html.includes('event.source !== parent'));
});

test("input validates exact supported shape and payload size", () => {
  const valid = { title: "Price simulator", description: "", html: "<h1>Hello</h1>", allowedMembers: [] };
  assert.equal(inputSchema.parse(valid).title, "Price simulator");
  assert.throws(() => inputSchema.parse({ ...valid, title: "" }));
  assert.throws(() => inputSchema.parse({ ...valid, html: "x".repeat(MAX_HTML_BYTES + 1) }));
  assert.throws(() => inputSchema.parse({ ...valid, backend: "python" }));
});
