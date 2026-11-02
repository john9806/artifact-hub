import { z } from "zod";
import { shaSchema } from "../shared/model.js";
import { HttpError } from "./errors.js";

const pullSchema = z.object({
  number: z.number(),
  html_url: z.string().url(),
  state: z.string(),
  merged: z.boolean(),
  head: z.object({ sha: shaSchema, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});
const reviewSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  state: z.string(),
  commit_id: z.string(),
});
export type Pull = z.infer<typeof pullSchema>;
export type Review = z.infer<typeof reviewSchema>;

export class GitHub {
  constructor(private repository: string, private token: string) {}

  async request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.github.com/repos/${this.repository}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok) {
      console.error("GitHub request failed", { method, endpoint, status: response.status });
      throw new HttpError(response.status === 404 ? 404 : 502, `GitHub ${method} ${endpoint} failed (${response.status}). Check repository access and branch rules.`);
    }
    return response.json();
  }

  async pull(number: number): Promise<Pull> {
    return pullSchema.parse(await this.request("GET", `/pulls/${number}`));
  }

  async create(branch: string, title: string, body: string): Promise<Pull> {
    const result = z.object({ number: z.number() }).parse(await this.request("POST", "/pulls", { head: branch, base: "main", title, body }));
    return this.pull(result.number);
  }

  async reviews(number: number): Promise<Review[]> {
    const reviews: Review[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = z.array(reviewSchema).parse(await this.request("GET", `/pulls/${number}/reviews?per_page=100&page=${page}`));
      reviews.push(...batch);
      if (batch.length < 100) return reviews;
    }
    throw new HttpError(422, "Too many reviews to validate safely.");
  }

  async files(number: number): Promise<string[]> {
    const result = z.array(z.object({ filename: z.string() })).parse(await this.request("GET", `/pulls/${number}/files?per_page=100`));
    if (result.length >= 100) throw new HttpError(422, "Promotion includes too many files.");
    return result.map((file) => file.filename);
  }

  async status(sha: string, previewUrl: string): Promise<void> {
    await this.request("POST", `/statuses/${sha}`, {
      state: "success",
      context: "artifact-hub/validated",
      description: "Artifact-only diff, immutable source and preview verified.",
      target_url: previewUrl,
    });
  }

  async previewComment(number: number, previewUrl: string): Promise<void> {
    await this.request("POST", `/issues/${number}/comments`, {
      body: `### Interactive artifact preview\n\n[Open the authenticated review preview](${previewUrl})\n\nThis preview is pinned to this PR's head. Review the interactive behavior, source, assumptions, and data grants. Approve the final head on GitHub, then use Artifact Hub to publish.`,
    });
  }

  async merge(number: number, sha: string): Promise<void> {
    const result = z.object({ merged: z.boolean(), message: z.string().optional() }).parse(
      await this.request("PUT", `/pulls/${number}/merge`, { sha, merge_method: "merge" }),
    );
    if (!result.merged) throw new HttpError(409, result.message ?? "GitHub refused to merge the promotion.");
  }
}

export function reviewDecision(reviews: Review[], head: string, reviewers: string[], requester: string) {
  const latest = new Map<string, Review>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.user.login.toLowerCase();
    if (reviewers.includes(login) && review.state !== "COMMENTED" && review.state !== "PENDING") {
      latest.set(login, review);
    }
  }
  const approvals: string[] = [];
  const blockers: string[] = [];
  for (const [login, review] of latest) {
    if (review.state === "CHANGES_REQUESTED") blockers.push(`@${login} requested changes.`);
    if (login !== requester.toLowerCase() && review.state === "APPROVED" && review.commit_id === head) approvals.push(login);
  }
  if (!approvals.length) blockers.push("A different configured reviewer must approve the current PR head on GitHub.");
  return { approvals, blockers };
}
