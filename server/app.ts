import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response, type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import path from "node:path";
import { idSchema, promotionSchema, saveSchema, shaSchema, type Artifact, type User } from "../shared/model.js";
import { type Config } from "./config.js";
import { HttpError } from "./errors.js";
import { signToken, verifyToken } from "./tokens.js";
import { Library } from "./library.js";
import { artifactCsp, frameDocument } from "./frame.js";
import { queryCube } from "./cube.js";

const sessionPayload = z.object({ kind: z.literal("session"), login: z.string(), exp: z.number() });
const previewPayload = z.object({
  kind: z.literal("preview"), id: idSchema, revision: shaSchema,
  login: z.string(), exp: z.number(),
});
const positiveInt = z.coerce.number().int().positive();
const environmentSchema = z.enum(["dev", "prod"]);
const previewRequestSchema = z.object({
  environment: environmentSchema.optional(),
  pullNumber: z.number().int().positive().optional(),
  revision: shaSchema.optional(),
  expectedRevision: shaSchema.optional(),
}).strict();

export function createApps(config: Config, library: Library, frontend?: RequestHandler) {
  const app = express();
  const artifacts = express();
  const cookieName = config.localDevelopment ? "artifact_hub_session" : "__Host-artifact_hub_session";
  const cookieOptions = { httpOnly: true, secure: !config.localDevelopment, sameSite: "lax" as const, path: "/" };
  const rateLimits = new Map<string, { started: number; count: number }>();
  const authenticated = (request: Request): User => {
    const payload = sessionPayload.safeParse(verifyToken(config.secret, String(request.cookies?.[cookieName] ?? "")));
    if (!payload.success) throw new HttpError(401, "Please sign in.");
    const login = payload.data.login.toLowerCase();
    if (config.localDevelopment && login === "local-developer") return { login, canWrite: true, canReview: false };
    if (!config.allowedUsers.includes(login)) throw new HttpError(403, "Your GitHub account is not permitted.");
    return { login, canWrite: config.writers.includes(login), canReview: config.reviewers.includes(login) };
  };
  const writer = (request: Request): User => {
    const user = authenticated(request);
    if (!user.canWrite) throw new HttpError(403, "You need a writer role.");
    return user;
  };
  const reviewer = (request: Request): User => {
    const user = authenticated(request);
    if (!user.canReview) throw new HttpError(403, "You need a reviewer role.");
    return user;
  };
  function limit(key: string, max: number, duration = 60_000): void {
    const now = Date.now();
    if (rateLimits.size > 2000) {
      for (const [name, entry] of rateLimits) if (now - entry.started > duration) rateLimits.delete(name);
    }
    const current = rateLimits.get(key);
    if (!current || now - current.started > duration) rateLimits.set(key, { count: 1, started: now });
    else if (++current.count > max) throw new HttpError(429, "Too many requests. Wait a minute before retrying.");
  }
  const security = (origin: string, frame: boolean) => (request: Request, response: Response, next: NextFunction) => {
    // Match the externally configured Host; reverse proxies must preserve it.
    if (request.headers.host !== new URL(origin).host) return response.status(421).send("Unexpected host.");
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Content-Security-Policy": frame ? artifactCsp(config.appOrigin) :
        `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${config.artifactOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    });
    if (!frame) response.set("X-Frame-Options", "DENY");
    next();
  };
  app.disable("x-powered-by");
  artifacts.disable("x-powered-by");
  app.use(security(config.appOrigin, false));
  artifacts.use(security(config.artifactOrigin, true));
  app.use(cookieParser());
  app.use((request, _response, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      (request.headers.origin !== config.appOrigin || request.headers["x-artifact-hub"] !== "1" ||
        !request.is("application/json"))) {
      throw new HttpError(403, "Same-origin JSON requests are required.");
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  artifacts.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/session", (request, response) => {
    const raw = sessionPayload.safeParse(verifyToken(config.secret, String(request.cookies?.[cookieName] ?? "")));
    response.json({
      user: raw.success ? authenticated(request) : null,
      localDevelopment: config.localDevelopment,
      cubeMembers: raw.success ? config.cubeMembers : [],
      repository: config.repository,
    });
  });
  app.post("/auth/local", (_request, response) => {
    if (!config.localDevelopment) throw new HttpError(404, "Not found.");
    response.cookie(cookieName, signToken(config.secret, { kind: "session", login: "local-developer" }, 3600), { ...cookieOptions, maxAge: 3_600_000 });
    response.json({ ok: true });
  });
  app.post("/auth/logout", (_request, response) => {
    response.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.get("/auth/github", (_request, response) => {
    if (!config.githubClientId) throw new HttpError(503, "Configure GitHub OAuth before signing in.");
    const state = randomBytes(32).toString("hex");
    response.cookie("artifact_hub_oauth", signToken(config.secret, { kind: "oauth", state }, 600), { ...cookieOptions, maxAge: 600_000 });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubClientId);
    url.searchParams.set("redirect_uri", `${config.appOrigin}/auth/callback`);
    url.searchParams.set("state", state);
    response.redirect(url.toString());
  });
  app.get("/auth/callback", async (request, response) => {
    const state = z.object({ kind: z.literal("oauth"), state: z.string() }).safeParse(
      verifyToken(config.secret, String(request.cookies?.artifact_hub_oauth ?? "")),
    );
    if (!state.success || typeof request.query.state !== "string" || state.data.state !== request.query.state ||
      typeof request.query.code !== "string") throw new HttpError(403, "OAuth state is invalid or expired. Sign in again.");
    response.clearCookie("artifact_hub_oauth", cookieOptions);
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.githubClientId, client_secret: config.githubClientSecret,
        code: request.query.code, redirect_uri: `${config.appOrigin}/auth/callback`,
      }),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!tokenResponse.ok) throw new HttpError(502, "GitHub token exchange failed.");
    const token = z.object({ access_token: z.string() }).safeParse(await tokenResponse.json());
    if (!token.success) throw new HttpError(401, "GitHub rejected the sign-in code.");
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!userResponse.ok) throw new HttpError(502, "Cannot verify GitHub identity.");
    const identity = z.object({ login: z.string() }).parse(await userResponse.json());
    const login = identity.login.toLowerCase();
    if (!config.allowedUsers.includes(login)) throw new HttpError(403, "Your GitHub account is not permitted.");
    response.cookie(cookieName, signToken(config.secret, { kind: "session", login }, 8 * 3600), { ...cookieOptions, maxAge: 8 * 3_600_000 });
    response.redirect("/");
  });
  app.use("/api", (request, _response, next) => {
    const user = authenticated(request);
    limit(`api:${user.login}`, 120);
    next();
  });
  app.get("/api/artifacts", async (request, response) => {
    response.json(await library.list(environmentSchema.parse(request.query.environment ?? "dev")));
  });
  app.post("/api/artifacts", async (request, response) => {
    const user = writer(request);
    const { expectedRevision, ...input } = saveSchema.parse(request.body);
    if (expectedRevision !== null) throw new HttpError(422, "New artifacts cannot have an expected revision.");
    response.status(201).json(await library.save(randomUUID(), input, null, user.login));
  });
  app.get("/api/artifacts/:id", async (request, response) => {
    response.json(await library.current(idSchema.parse(request.params.id), environmentSchema.parse(request.query.environment ?? "dev")));
  });
  app.put("/api/artifacts/:id", async (request, response) => {
    const user = writer(request);
    const { expectedRevision, ...input } = saveSchema.parse(request.body);
    if (!expectedRevision) throw new HttpError(422, "Editing requires the revision you started from.");
    response.json(await library.save(idSchema.parse(request.params.id), input, expectedRevision, user.login));
  });
  app.get("/api/artifacts/:id/history", async (request, response) => {
    response.json(await library.history(idSchema.parse(request.params.id)));
  });
  app.get("/api/artifacts/:id/revisions/:revision", async (request, response) => {
    response.json(await library.get(idSchema.parse(request.params.id), shaSchema.parse(request.params.revision)));
  });
  app.post("/api/artifacts/:id/promote", async (request, response) => {
    const user = writer(request);
    limit(`promote:${user.login}`, 5);
    response.status(201).json(await library.promote(idSchema.parse(request.params.id), promotionSchema.parse(request.body).expectedRevision, user.login));
  });
  app.get("/api/promotions", async (_request, response) => {
    const pulls = z.array(z.object({
      number: z.number(), title: z.string(), html_url: z.string(),
      head: z.object({ ref: z.string() }),
    })).parse(await library.github.request("GET", "/pulls?state=open&base=main&per_page=100"));
    response.json(pulls.filter((pull) => pull.head.ref.startsWith("promotion/")));
  });
  app.get("/api/promotions/:number", async (request, response) => {
    response.json(await library.inspect(positiveInt.parse(request.params.number)));
  });
  app.post("/api/promotions/:number/publish", async (request, response) => {
    reviewer(request);
    const { head } = z.object({ head: shaSchema }).strict().parse(request.body);
    await library.publish(positiveInt.parse(request.params.number), head);
    response.json({ ok: true });
  });
  async function resolveArtifact(id: string, raw: unknown): Promise<Artifact> {
    const input = previewRequestSchema.parse(raw);
    if ([input.environment, input.pullNumber, input.revision].filter((value) => value !== undefined).length !== 1) {
      throw new HttpError(422, "Choose exactly one preview source.");
    }
    let artifact: Artifact;
    if (input.pullNumber) {
      const promotion = await library.inspect(input.pullNumber);
      if (promotion.artifact.id !== id) throw new HttpError(403, "PR does not contain this artifact.");
      artifact = promotion.artifact;
    } else if (input.revision) artifact = await library.get(id, input.revision);
    else artifact = await library.current(id, input.environment!);
    if (input.expectedRevision && input.expectedRevision !== artifact.revision) {
      throw new HttpError(409, "This version changed. Reopen the artifact or refresh the review before previewing.");
    }
    return artifact;
  }
  app.post("/api/artifacts/:id/preview", async (request, response) => {
    const user = authenticated(request);
    const artifact = await resolveArtifact(idSchema.parse(request.params.id), request.body);
    const token = signToken(config.secret, { kind: "preview", id: artifact.id, revision: artifact.revision, login: user.login }, 600);
    response.json({ url: `${config.artifactOrigin}/render?token=${encodeURIComponent(token)}`, expiresIn: 600 });
  });
  app.post("/api/artifacts/:id/query", async (request, response) => {
    const user = authenticated(request);
    limit(`cube:${user.login}`, 30);
    const body = z.object({ source: previewRequestSchema, query: z.unknown() }).strict().parse(request.body);
    const artifact = await resolveArtifact(idSchema.parse(request.params.id), body.source);
    response.json(await queryCube(config, artifact, user, body.query));
  });
  artifacts.get("/render", async (request, response) => {
    const payload = previewPayload.safeParse(verifyToken(config.secret, String(request.query.token ?? "")));
    if (!payload.success) throw new HttpError(403, "Preview link expired. Refresh the preview from Artifact Hub.");
    const fetchDestination = request.headers["sec-fetch-dest"];
    if (fetchDestination !== "iframe") throw new HttpError(403, "Artifacts can only be opened in an Artifact Hub preview frame.");
    if (!(config.localDevelopment && payload.data.login === "local-developer") && !config.allowedUsers.includes(payload.data.login)) {
      throw new HttpError(403, "Preview access has been revoked.");
    }
    const artifact = await library.get(payload.data.id, payload.data.revision);
    response.type("html").send(frameDocument(artifact.html, config.appOrigin));
  });
  artifacts.use((_request, response) => response.status(404).send("Not found."));
  app.use("/api", (_request, _response) => { throw new HttpError(404, "API endpoint not found."); });
  if (frontend) app.use(frontend);
  app.use(express.static(path.resolve("dist/client"), { index: false }));
  app.get(["/", "/review/:number"], (_request, response) => response.sendFile(path.resolve("dist/client/index.html")));
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof z.ZodError) {
      response.status(422).json({ error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    } else if (error instanceof HttpError) {
      console.warn("Request rejected", { status: error.status, message: error.message });
      response.status(error.status).json({ error: error.message });
    } else if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Malformed JSON request." });
    } else if (error instanceof Error && "status" in error && error.status === 413) {
      response.status(413).json({ error: "Request exceeds the 2 MB body limit." });
    } else {
      console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
      response.status(500).json({ error: "The operation failed. Check the server logs before retrying." });
    }
  };
  app.use(errorHandler);
  artifacts.use(errorHandler);
  return { app, artifacts };
}
