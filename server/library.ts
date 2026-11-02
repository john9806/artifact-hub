import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Artifact, type ArtifactInput, type ArtifactSummary, type Environment,
  type Manifest, type Promotion, MAX_HTML_BYTES, idSchema, manifestSchema,
} from "../shared/model.js";
import { GitStore } from "./git.js";
import { GitHub, reviewDecision, type Pull } from "./github.js";
import { HttpError } from "./errors.js";

export const DEV_BRANCH = "artifact-dev";
export const digest = (html: string) => createHash("sha256").update(html).digest("hex");
const root = (id: string) => `artifacts/${idSchema.parse(id)}`;
export const artifactFiles = (manifest: Manifest, html: string) => ({
  [`${root(manifest.id)}/artifact.json`]: JSON.stringify(manifest, null, 2) + "\n",
  [`${root(manifest.id)}/artifact.html`]: html,
});
export const manifestOf = ({ html: _html, revision: _revision, ...manifest }: Artifact): Manifest => manifestSchema.parse(manifest);
export type LibraryOptions = { repository: string; appOrigin: string; reviewers: string[]; cubeMembers: string[] };

export class Library {
  constructor(readonly git: GitStore, readonly github: GitHub, private options: LibraryOptions) {}

  async branch(environment: Environment): Promise<string> {
    return environment === "prod" ? "main" : await this.git.exists(DEV_BRANCH) ? DEV_BRANCH : "main";
  }

  async get(id: string, revision: string): Promise<Artifact> {
    const files = await this.git.files(revision, `${root(id)}/`);
    if (!files.includes(`${root(id)}/artifact.json`)) throw new HttpError(404, "Artifact not found.");
    const manifest = manifestSchema.parse(JSON.parse(await this.git.read(revision, `${root(id)}/artifact.json`)));
    const html = await this.git.read(revision, `${root(id)}/artifact.html`);
    if (manifest.id !== id || digest(html) !== manifest.digest || Buffer.byteLength(html) > MAX_HTML_BYTES) {
      throw new HttpError(422, "Artifact integrity validation failed.");
    }
    return { ...manifest, html, revision };
  }

  async list(environment: Environment): Promise<ArtifactSummary[]> {
    await this.git.refresh();
    const revision = await this.git.head(await this.branch(environment));
    const files = await this.git.files(revision, "artifacts/");
    const manifests = files.filter((file) => /^artifacts\/[a-f0-9-]{36}\/artifact\.json$/.test(file));
    const result: ArtifactSummary[] = [];
    for (const file of manifests) {
      const artifact = environment === "prod"
        ? await this.production(file.split("/")[1]!, revision)
        : await this.get(file.split("/")[1]!, revision);
      const { html: _html, ...summary } = artifact;
      result.push(summary);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async current(id: string, environment: Environment): Promise<Artifact> {
    await this.git.refresh();
    const revision = await this.git.head(await this.branch(environment));
    return environment === "prod" ? this.production(id, revision) : this.get(id, revision);
  }

  async production(id: string, revision: string): Promise<Artifact> {
    const artifact = await this.get(id, revision);
    if (!artifact.pullNumber) throw new HttpError(422, "Production artifact has no approval record.");
    const promotion = await this.inspect(artifact.pullNumber);
    if (!promotion.merged || promotion.blockers.length ||
      JSON.stringify(manifestOf(artifact)) !== JSON.stringify(manifestOf(promotion.artifact)) ||
      artifact.html !== promotion.artifact.html) {
      throw new HttpError(422, "Production artifact does not match an approved, merged promotion.");
    }
    return artifact;
  }

  async save(id: string, input: ArtifactInput, expectedRevision: string | null, actor: string): Promise<Artifact> {
    idSchema.parse(id);
    if (Buffer.byteLength(input.html) > MAX_HTML_BYTES) throw new HttpError(413, "HTML must be at most 1 MB.");
    if (input.allowedMembers.some((member) => !this.options.cubeMembers.includes(member))) {
      throw new HttpError(422, "Artifact requests a Cube member not allowed by the administrator.");
    }
    return this.git.serial(async () => {
      await this.git.refresh();
      const parent = await this.git.head(await this.branch("dev"));
      const files = await this.git.files(parent, `${root(id)}/`);
      const exists = files.includes(`${root(id)}/artifact.json`);
      if (exists !== Boolean(expectedRevision)) throw new HttpError(409, "Artifact already exists or was removed. Refresh before saving.");
      let owner = actor;
      if (exists) {
        const current = await this.get(id, parent);
        const previous = await this.get(id, expectedRevision!);
        if (JSON.stringify(manifestOf(current)) !== JSON.stringify(manifestOf(previous))) {
          throw new HttpError(409, "Another user edited this artifact. Reload it before saving.");
        }
        owner = current.owner;
      }
      const { html, ...metadata } = input;
      const manifest: Manifest = {
        ...metadata, id, owner, updatedBy: actor, updatedAt: new Date().toISOString(), digest: digest(html),
      };
      const revision = await this.git.commit(DEV_BRANCH, parent, artifactFiles(manifest, html), `Update DEV artifact: ${input.title}\n\nActor: ${actor}\n`);
      return { ...manifest, html, revision };
    });
  }

  async promote(id: string, expectedRevision: string, actor: string): Promise<Promotion> {
    const number = await this.git.serial(async () => {
      await this.git.refresh();
      const source = await this.get(id, expectedRevision);
      const current = await this.get(id, await this.git.head(await this.branch("dev")));
      if (source.digest !== current.digest || JSON.stringify(manifestOf(source)) !== JSON.stringify(manifestOf(current))) {
        throw new HttpError(409, "DEV changed. Reload and request publication of the latest version.");
      }
      const parent = await this.git.head("main");
      const branch = `promotion/${id}/${randomUUID()}`;
      const { html, revision: _revision, ...metadata } = source;
      let manifest: Manifest = { ...metadata, sourceRevision: expectedRevision, requestedBy: actor };
      await this.git.commit(branch, parent, artifactFiles(manifest, html), `Propose artifact: ${source.title}\n`);
      const pull = await this.github.create(branch, `Publish: ${source.title}`,
        `## Artifact publication\n\nRequested by **@${actor}**.\n\nSource: \`${expectedRevision}\`\n\nHTML SHA-256: \`${source.digest}\`\n\nOpen **${this.options.appOrigin}** and its Reviews tab to inspect this PR. A direct preview link will be recorded in the artifact-hub/validated check.\n\nOnly this artifact is promoted. Review both behavior and calculation correctness. Approval must apply to the final PR head. Use Artifact Hub to publish after approval.`);
      manifest = { ...manifest, pullNumber: pull.number };
      await this.git.commit(branch, await this.git.head(branch), artifactFiles(manifest, html), `Bind artifact preview to PR #${pull.number}\n`);
      const validated = await this.inspect(pull.number);
      await this.github.status(validated.head, `${this.options.appOrigin}/review/${pull.number}`);
      await this.github.previewComment(pull.number, `${this.options.appOrigin}/review/${pull.number}`);
      return pull.number;
    });
    return this.inspect(number);
  }

  private validatePull(pull: Pull): void {
    if (pull.base.ref !== "main" ||
      pull.base.repo.full_name.toLowerCase() !== this.options.repository.toLowerCase() ||
      pull.head.repo?.full_name.toLowerCase() !== this.options.repository.toLowerCase() ||
      !/^promotion\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(pull.head.ref)) {
      throw new HttpError(422, "This is not an Artifact Hub promotion in the configured repository.");
    }
  }

  async inspect(number: number): Promise<Promotion> {
    const pull = await this.github.pull(number);
    this.validatePull(pull);
    await this.git.refresh();
    const id = idSchema.parse(pull.head.ref.split("/")[1]);
    const artifact = await this.get(id, pull.head.sha);
    if (artifact.pullNumber !== number || !artifact.sourceRevision || !artifact.requestedBy) {
      throw new HttpError(422, "Promotion metadata is incomplete.");
    }
    const source = await this.get(id, artifact.sourceRevision);
    const expected = { ...manifestOf(source), sourceRevision: source.revision, requestedBy: artifact.requestedBy, pullNumber: number };
    if (JSON.stringify(manifestSchema.parse(expected)) !== JSON.stringify(manifestOf(artifact)) || source.html !== artifact.html) {
      throw new HttpError(422, "Promotion does not exactly match its immutable DEV revision.");
    }
    const files = await this.github.files(number);
    const allowed = Object.keys(artifactFiles(manifestOf(artifact), artifact.html));
    if (!files.length || files.some((file) => !allowed.includes(file))) throw new HttpError(422, "PR changes files outside this artifact.");
    const decision = reviewDecision(await this.github.reviews(number), pull.head.sha, this.options.reviewers, artifact.requestedBy);
    return {
      number, url: pull.html_url, state: pull.state, head: pull.head.sha, artifact,
      ...decision, merged: pull.merged,
      canPublish: pull.state === "open" && !decision.blockers.length,
    };
  }

  async publish(number: number, expectedHead: string): Promise<void> {
    const promotion = await this.inspect(number);
    if (promotion.head !== expectedHead) throw new HttpError(409, "PR changed. Refresh its preview.");
    if (!promotion.canPublish) throw new HttpError(403, promotion.blockers.join(" ") || "This PR cannot be published.");
    await this.github.status(promotion.head, `${this.options.appOrigin}/review/${number}`);
    await this.github.merge(number, promotion.head);
    await this.git.refresh();
    const live = await this.get(promotion.artifact.id, await this.git.head("main"));
    if (live.digest !== promotion.artifact.digest || live.pullNumber !== number) {
      throw new HttpError(409, "Merge completed, but production moved again. Inspect the current production release.");
    }
  }

  async history(id: string): Promise<{ revision: string; title: string; at: string }[]> {
    await this.git.refresh();
    const head = await this.git.head(await this.branch("dev"));
    const log = await this.git.git(["log", "-30", "--format=%H%x09%aI%x09%s", head, "--", `${root(id)}/`]);
    return log ? log.split("\n").map((line) => {
      const [revision, at, title] = line.split("\t");
      return z.object({ revision: z.string(), at: z.string(), title: z.string() }).parse({ revision, at, title });
    }) : [];
  }
}
