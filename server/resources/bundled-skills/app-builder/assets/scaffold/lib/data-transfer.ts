import { z } from "zod";
import { contactStatusSchema } from "./domain";

export const exportedContactSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  email: z.email().max(320),
  company: z.string().max(160),
  status: contactStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const importEnvelopeSchema = z.object({
  format: z.literal("rudder-app-data/v1"),
  exportedAt: z.iso.datetime(),
  data: z.object({
    contacts: z.array(exportedContactSchema).max(100_000),
  }),
}).strict();

type ContactRow = {
  id: string;
  name: string;
  email: string;
  company: string;
  status: "new" | "contacted" | "replied" | "paused";
  createdAt: Date;
  updatedAt: Date;
};

export function buildExportEnvelope(rows: ContactRow[]) {
  return {
    format: "rudder-app-data/v1" as const,
    exportedAt: new Date().toISOString(),
    data: {
      contacts: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    },
  };
}
