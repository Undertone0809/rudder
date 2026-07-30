import { z } from "zod";

export const contactStatusSchema = z.enum(["new", "contacted", "replied", "paused"]);

export const contactCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  company: z.string().trim().max(160).default(""),
  status: contactStatusSchema.default("new"),
});

export const contactUpdateSchema = contactCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one contact field is required",
);

export type ContactInput = z.infer<typeof contactCreateSchema>;
export type ContactStatus = z.infer<typeof contactStatusSchema>;
