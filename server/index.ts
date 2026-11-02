import { mkdir, open, unlink } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { loadConfig } from "./config.js";
import { GitStore } from "./git.js";
import { GitHub } from "./github.js";
import { Library } from "./library.js";
import { createApps } from "./app.js";

try { loadEnvFile(); }
catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
const lockPath = path.join(config.dataDir, "instance.lock");
const lock = await open(lockPath, "wx");
await lock.writeFile(`${process.pid}\n`);
try {
  const git = new GitStore({
    directory: path.join(config.dataDir, "repository.git"),
    remote: `https://github.com/${config.repository}.git`,
    token: config.githubToken,
  });
  await git.initialize();
  const library = new Library(git, new GitHub(config.repository, config.githubToken), {
    repository: config.repository,
    appOrigin: config.appOrigin,
    reviewers: config.reviewers,
    cubeMembers: config.cubeMembers,
  });
  let frontend;
  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    frontend = vite.middlewares;
  }
  const { app, artifacts } = createApps(config, library, frontend);
  const appServer = app.listen(config.port, config.host, () => console.log(`Artifact Hub: ${config.appOrigin}`));
  const artifactServer = artifacts.listen(config.artifactPort, config.host, () => console.log(`Artifact previews: ${config.artifactOrigin}`));
  const shutdown = async () => {
    appServer.close();
    artifactServer.close();
    await lock.close();
    await unlink(lockPath);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  await lock.close();
  await unlink(lockPath);
  throw error;
}
