import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { HttpError } from "./errors.js";

export type GitOptions = { directory: string; remote: string; token?: string };

export class GitStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: GitOptions) {}

  async git(args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}, raw = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const auth = this.options.token ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${this.options.token}`).toString("base64")}`,
      } : {};
      const child = spawn("git", ["--git-dir", this.options.directory, ...args], {
        env: {
          ...process.env, ...auth, ...extraEnv, GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Artifact Hub", GIT_AUTHOR_EMAIL: "artifact-hub@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Artifact Hub", GIT_COMMITTER_EMAIL: "artifact-hub@users.noreply.github.com",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output: Buffer[] = [];
      let outputBytes = 0;
      let error = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output.push(chunk);
        outputBytes += chunk.byteLength;
        if (outputBytes > 16_000_000) child.kill("SIGTERM");
      });
      child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        const content = Buffer.concat(output).toString("utf8");
        if (code === 0) resolve(raw ? content : content.trimEnd());
        else reject(new Error(`Git ${args[0]} failed (${code}): ${error.replaceAll(this.options.token ?? "\0", "[redacted]")}`));
      });
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") reject(err);
      });
      child.stdin.end(input);
    });
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    await this.git(["init", "--bare", "--quiet"]);
    const remotes = await this.git(["remote"]);
    if (remotes.split("\n").includes("origin")) await this.git(["remote", "set-url", "origin", this.options.remote]);
    else await this.git(["remote", "add", "origin", this.options.remote]);
    await this.refresh();
    await this.head("main");
  }

  async refresh(): Promise<void> {
    await this.git(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  }

  async exists(branch: string): Promise<boolean> {
    const refs = await this.git(["for-each-ref", "--format=%(refname)", `refs/remotes/origin/${branch}`]);
    return refs.split("\n").includes(`refs/remotes/origin/${branch}`);
  }

  async head(branch: string): Promise<string> {
    return this.git(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]);
  }

  async files(revision: string, prefix: string): Promise<string[]> {
    return (await this.git(["ls-tree", "-r", "--name-only", revision, "--", prefix])).split("\n").filter(Boolean);
  }

  async read(revision: string, filename: string): Promise<string> {
    return this.git(["show", `${revision}:${filename}`], undefined, {}, true);
  }

  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async commit(branch: string, parent: string, files: Record<string, string>, message: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "artifact-hub-index-"));
    const env = { GIT_INDEX_FILE: path.join(directory, "index") };
    try {
      await this.git(["read-tree", parent], undefined, env);
      for (const [filename, content] of Object.entries(files)) {
        const hash = await this.git(["hash-object", "-w", "--stdin"], content);
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${hash},${filename}`], undefined, env);
      }
      const tree = await this.git(["write-tree"], undefined, env);
      const sha = await this.git(["commit-tree", tree, "-p", parent], message);
      try { await this.git(["push", "--quiet", "origin", `${sha}:refs/heads/${branch}`]); }
      catch (error) {
        throw new HttpError(409, `Repository changed or push was rejected. Refresh and retry. ${error instanceof Error ? error.message : "Git push failed."}`);
      }
      await this.refresh();
      return sha;
    } finally { await rm(directory, { recursive: true }); }
  }
}
