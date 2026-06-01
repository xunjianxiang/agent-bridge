import { z } from "zod";

export const providerIdSchema = z.enum(["codex", "claude", "gemini"]);

export const providerInputSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("local_image"), path: z.string() })
    ])
  )
]);

export const providerRequestSchema = z.object({
  provider: providerIdSchema,
  input: providerInputSchema,
  cwd: z.string().optional(),
  model: z.string().optional(),
  session: z.string().optional(),
  nativeOptions: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type ProviderRequestDto = z.infer<typeof providerRequestSchema>;
