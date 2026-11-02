import path from "node:path";
import { z } from "zod";
import { memberSchema } from "../shared/model.js";

const names = (value: string | undefined) =>
  (value ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);

export type Config = {
  appOrigin: string;
  artifactOrigin: string;
  port: number;
  artifactPort: number;
  host: string;
  dataDir: string;
  secret: string;
  localDevelopment: boolean;
  repository: string;
  githubToken: string;
  githubClientId: string;
  githubClientSecret: string;
  allowedUsers: string[];
  writers: string[];
  reviewers: string[];
  cubeUrl?: string;
  cubeSecret?: string;
  cubeMembers: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const localDevelopment = env.LOCAL_DEVELOPMENT === "true";
  if (localDevelopment && env.NODE_ENV === "production") {
    throw new Error("LOCAL_DEVELOPMENT cannot be enabled in production.");
  }
  const origin = (value: string, localHost: string) => {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) throw new Error("Origins must be bare origins without paths.");
    if (localDevelopment) {
      if (url.hostname !== localHost || url.protocol !== "http:") {
        throw new Error(`Local development requires http://${localHost} origins.`);
      }
    } else if (url.protocol !== "https:") throw new Error("Production requires HTTPS origins.");
    return url.origin;
  };
  const appOrigin = origin(env.APP_ORIGIN ?? "http://localhost:3000", "localhost");
  const artifactOrigin = origin(env.ARTIFACT_ORIGIN ?? "http://127.0.0.1:3001", "127.0.0.1");
  if (new URL(appOrigin).hostname === new URL(artifactOrigin).hostname) {
    throw new Error("App and artifact hosts must use different hostnames, not just different ports.");
  }
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).parse(env.GITHUB_REPOSITORY);
  const githubToken = env.GITHUB_TOKEN ?? "";
  if (!githubToken) throw new Error("GITHUB_TOKEN is required to maintain the artifact repository.");
  const allowedUsers = names(env.GITHUB_ALLOWED_USERS);
  const writers = names(env.GITHUB_WRITERS);
  const reviewers = names(env.GITHUB_REVIEWERS);
  if (!localDevelopment && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !allowedUsers.length)) {
    throw new Error("Production requires GitHub OAuth configuration and an explicit user allowlist.");
  }
  for (const login of [...writers, ...reviewers]) {
    if (!allowedUsers.includes(login)) throw new Error(`Role user ${login} is missing from GITHUB_ALLOWED_USERS.`);
  }
  // Cube member names are case-sensitive.
  const parsedMembers = (env.CUBE_ALLOWED_MEMBERS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  parsedMembers.forEach((v) => memberSchema.parse(v));
  if (Boolean(env.CUBE_API_URL) !== Boolean(env.CUBE_API_SECRET)) {
    throw new Error("Set both CUBE_API_URL and CUBE_API_SECRET, or neither.");
  }
  if (env.CUBE_API_URL) {
    const url = new URL(env.CUBE_API_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("CUBE_API_URL must be an HTTP(S) Cube REST base URL without credentials or query parameters.");
    }
    if (!parsedMembers.length) throw new Error("Configure CUBE_ALLOWED_MEMBERS before enabling Cube.");
  } else if (parsedMembers.length) throw new Error("Cube members were configured without a Cube connection.");
  const port = (value: string | undefined, fallback: number) => z.coerce.number().int().min(1).max(65535).parse(value ?? fallback);
  return {
    appOrigin, artifactOrigin, secret, repository, githubToken, localDevelopment,
    host: localDevelopment ? "127.0.0.1" : "0.0.0.0",
    port: port(env.PORT, 3000),
    artifactPort: port(env.ARTIFACT_PORT, 3001),
    dataDir: path.resolve(env.DATA_DIR ?? ".data"),
    githubClientId: env.GITHUB_CLIENT_ID ?? "",
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    allowedUsers, writers, reviewers,
    cubeUrl: env.CUBE_API_URL?.replace(/\/$/, ""),
    cubeSecret: env.CUBE_API_SECRET,
    cubeMembers: parsedMembers,
  };
}
