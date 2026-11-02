import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { artifactFiles, manifestOf } from "../server/library.js";
import { fixture } from "./helpers.js";

const input = (title: string, html = "<h1>Version A</h1>\n\n") => ({ title, html, description: "Synthetic example", allowedMembers: [] });

test("Git drafts preserve exact Unicode bytes, are immutable, and reject concurrent edits to the same artifact", async () => {
  const f = await fixture();
  try {
    const a = await f.library.save(randomUUID(), input("Pricing", "<p>Résumé / 日本語</p> \n\n"), null, "alice");
    const b = await f.library.save(randomUUID(), input("Other"), null, "alice");
    assert.equal((await f.library.get(a.id, a.revision)).html, a.html);
    const updated = await f.library.save(a.id, input("Pricing updated"), a.revision, "alice");
    assert.equal((await f.library.current(b.id, "dev")).digest, b.digest);
    await assert.rejects(() => f.library.save(a.id, input("Stale"), a.revision, "alice"), /Another user edited/);
    assert.equal((await f.library.get(a.id, a.revision)).title, "Pricing");
    assert.equal((await f.library.current(a.id, "dev")).title, updated.title);
    assert.equal((await f.library.history(a.id)).length, 2);
    await assert.rejects(() => f.library.save(a.id, input("Duplicate"), null, "alice"), /already exists/);
    await assert.rejects(() => f.library.save(randomUUID(), { ...input("Denied"), allowedMembers: ["Secret.value"] }, null, "alice"), /not allowed/);
  } finally { await f.close(); }
});

test("approval publishes only the pinned artifact, not later DEV edits or unrelated artifacts", async () => {
  const f = await fixture();
  try {
    const a = await f.library.save(randomUUID(), input("Pricing"), null, "alice");
    const b = await f.library.save(randomUUID(), input("Unrelated"), null, "alice");
    const promotion = await f.library.promote(a.id, a.revision, "alice");
    assert.ok(!promotion.canPublish);
    assert.equal(promotion.artifact.html, a.html);
    await assert.rejects(() => f.library.publish(promotion.number, promotion.head), /reviewer/);
    const next = await f.library.save(a.id, input("Pricing", "<h1>Version B</h1>"), a.revision, "alice");
    f.github.approve(promotion.number, promotion.head);
    await f.library.publish(promotion.number, promotion.head);
    const production = await f.library.current(a.id, "prod");
    assert.equal(production.html, a.html);
    assert.notEqual(production.html, next.html);
    assert.equal((await f.library.current(a.id, "dev")).html, next.html);
    await assert.rejects(() => f.library.current(b.id, "prod"), /not found/);
    assert.equal((await f.library.list("prod")).length, 1);
    assert.equal((await f.library.list("dev")).length, 2);
    assert.deepEqual(await f.github.files(promotion.number), [`artifacts/${a.id}/artifact.html`, `artifacts/${a.id}/artifact.json`].sort());
  } finally { await f.close(); }
});

test("new PR commits invalidate old-head approval and tampered or unrelated promotion changes fail closed", async () => {
  const f = await fixture();
  try {
    const artifact = await f.library.save(randomUUID(), input("Pricing"), null, "alice");
    const promotion = await f.library.promote(artifact.id, artifact.revision, "alice");
    f.github.approve(promotion.number, promotion.head);
    const pull = await f.github.pull(promotion.number);
    const head = await f.git.commit(pull.head.ref, pull.head.sha, artifactFiles(manifestOf(promotion.artifact), artifact.html), "New commit");
    assert.notEqual(head, promotion.head);
    assert.ok(!(await f.library.inspect(promotion.number)).canPublish);
    await assert.rejects(() => f.library.publish(promotion.number, promotion.head), /changed/);
    f.github.approve(promotion.number, head);
    f.github.extraFiles = ["server/app.ts"];
    await assert.rejects(() => f.library.inspect(promotion.number), /outside this artifact/);
    f.github.extraFiles = [];
    const modified = { ...manifestOf(promotion.artifact), title: "Unreviewed metadata" };
    await f.git.commit(pull.head.ref, head, artifactFiles(modified, artifact.html), "Tamper");
    await assert.rejects(() => f.library.inspect(promotion.number), /does not exactly match/);
  } finally { await f.close(); }
});

test("production rejects bypassed merges and allows rollback through a new draft and approval", async () => {
  const f = await fixture();
  try {
    const initial = await f.library.save(randomUUID(), input("Original"), null, "alice");
    await f.git.commit("main", await f.git.head("main"), artifactFiles(manifestOf(initial), initial.html), "Bypass approval");
    await assert.rejects(() => f.library.current(initial.id, "prod"), /no approval record/);
    const updated = await f.library.save(initial.id, input("Updated", "<p>New</p>"), initial.revision, "alice");
    const restored = await f.library.save(initial.id, input(initial.title, initial.html), updated.revision, "alice");
    assert.notEqual(restored.revision, initial.revision);
    const promotion = await f.library.promote(restored.id, restored.revision, "alice");
    f.github.approve(promotion.number, promotion.head, "alice");
    assert.ok(!(await f.library.inspect(promotion.number)).canPublish);
    f.github.approve(promotion.number, promotion.head, "bob");
    await f.library.publish(promotion.number, promotion.head);
    assert.equal((await f.library.current(initial.id, "prod")).html, initial.html);
    f.github.approve(promotion.number, promotion.head, "bob", "DISMISSED");
    await assert.rejects(() => f.library.current(initial.id, "prod"), /approved, merged/);
  } finally { await f.close(); }
});
