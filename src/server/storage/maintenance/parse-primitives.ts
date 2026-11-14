import { z } from "zod";

// Shared identity/reference shapes keep the journal and embedded roster in the same domain.
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const text = z.string().min(1).max(4096);
export const counter = z.number().int().nonnegative().safe();
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const ref = z.object({ ref: text, sha256: hash, bytes: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict();
export const source = z.object({ kind: z.enum(["sqlite", "postgres"]), databaseInstanceId: z.string().regex(/^[a-f0-9]{32}$/), identityDigest: hash }).strict();
