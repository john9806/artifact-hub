import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitStore } from "../server/git.js";
import { GitHub, type Pull, type Review } from "../server/github.js";
import { Library, artifactFiles, manifestOf } from "../server/library.js";
import type { Config } from "../server/config.js";

const exec = promisify(execFile);
export const config: Config = {
  appOrigin: "http://localhost:3000", artifactOrigin: "http://127.0.0.1:3001",
  port: 3000, artifactPort: 3001, host: "127.0.0.1", dataDir: "/tmp/unused",
  secret: "test-only-secret-that-is-long-enough-123456", localDevelopment: true,
  repository: "test-owner/test-hub", githubToken: "test-token", githubClientId: "", githubClientSecret: "",
  allowedUsers: ["alice", "bob", "carol"], writers: ["alice"], reviewers: ["bob", "carol"],
  cubeMembers: ["Orders.count", "Orders.region"],
};

export class FakeGitHub extends GitHub {
  pulls = new Map<number, Pull>();
  recordedReviews = new Map<number, Review[]>();
  extraFiles: string[] = [];
  statuses: string[] = [];
  constructor(private store: GitStore) { super(config.repository, "test"); }
  override async pull(number: number): Promise<Pull> {
    const pull = this.pulls.get(number);
    if (!pull) throw new Error("Missing test PR");
    pull.head.sha = await this.store.head(pull.head.ref);
    return structuredClone(pull);
  }
  override async create(branch: string): Promise<Pull> {
    const number = this.pulls.size + 1;
    const repo = { full_name: config.repository };
    const pull: Pull = {
      number, html_url: `https://github.com/${config.repository}/pull/${number}`, state: "open", merged: false,
      head: { sha: await this.store.head(branch), ref: branch, repo }, base: { ref: "main", repo },
    };
    this.pulls.set(number, pull);
    return structuredClone(pull);
  }
  override async reviews(number: number): Promise<Review[]> { return this.recordedReviews.get(number) ?? []; }
  override async files(number: number): Promise<string[]> {
    const pull = await this.pull(number);
    const filenames = (await this.store.git(["diff", "--name-only", `refs/remotes/origin/main...${pull.head.sha}`])).split("\n").filter(Boolean);
    return [...filenames, ...this.extraFiles];
  }
  override async status(sha: string): Promise<void> { this.statuses.push(sha); }
  override async previewComment(): Promise<void> {}
  override async merge(number: number, sha: string): Promise<void> {
    const pull = await this.pull(number);
    if (pull.head.sha !== sha) throw new Error("Stale PR head");
    const id = pull.head.ref.split("/")[1]!;
    const artifact = await new Library(this.store, this, config).get(id, sha);
    await this.store.commit("main", await this.store.head("main"), artifactFiles(manifestOf(artifact), artifact.html), "Test merge");
    this.pulls.set(number, { ...pull, merged: true, state: "closed" });
  }
  approve(number: number, head: string, login = "bob", state = "APPROVED"): void {
    const reviews = this.recordedReviews.get(number) ?? [];
    reviews.push({ id: reviews.length + 1, user: { login }, state, commit_id: head });
    this.recordedReviews.set(number, reviews);
  }
}

export async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-hub-test-"));
  const seed = path.join(directory, "seed");
  const remote = path.join(directory, "remote.git");
  await mkdir(seed);
  await exec("git", ["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(path.join(seed, "README.md"), "# Test repository\n");
  await exec("git", ["-C", seed, "add", "README.md"]);
  await exec("git", ["-C", seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Initial"]);
  await exec("git", ["clone", "--bare", "--quiet", seed, remote]);
  const git = new GitStore({ directory: path.join(directory, "cache.git"), remote });
  await git.initialize();
  const github = new FakeGitHub(git);
  const library = new Library(git, github, { ...config, reviewers: config.reviewers });
  return { directory, git, github, library, close: () => rm(directory, { recursive: true, force: true }) };
}
