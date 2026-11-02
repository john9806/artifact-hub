import { z } from "zod";

export const MAX_HTML_BYTES = 1_000_000;
export const idSchema = z.string().uuid();
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const memberSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/);
export const inputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(800),
  html: z.string().min(1).max(MAX_HTML_BYTES),
  allowedMembers: z.array(memberSchema).max(100),
}).strict();
export const manifestSchema = inputSchema.omit({ html: true }).extend({
  id: idSchema,
  owner: z.string().min(1),
  updatedBy: z.string().min(1),
  updatedAt: z.string().datetime(),
  digest: digestSchema,
  sourceRevision: shaSchema.optional(),
  requestedBy: z.string().optional(),
  pullNumber: z.number().int().positive().optional(),
}).strict();
export const saveSchema = inputSchema.extend({ expectedRevision: shaSchema.nullable() }).strict();
export const promotionSchema = z.object({ expectedRevision: shaSchema }).strict();
export type ArtifactInput = z.infer<typeof inputSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Artifact = Manifest & { html: string; revision: string };
export type ArtifactSummary = Omit<Artifact, "html">;
export type Environment = "dev" | "prod";
export type User = { login: string; canWrite: boolean; canReview: boolean };
export type Session = {
  user: User | null;
  localDevelopment: boolean;
  cubeMembers: string[];
  repository: string;
};
export type Promotion = {
  number: number;
  url: string;
  state: string;
  head: string;
  artifact: Artifact;
  approvals: string[];
  blockers: string[];
  canPublish: boolean;
  merged: boolean;
};
