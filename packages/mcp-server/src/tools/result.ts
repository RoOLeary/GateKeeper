import { z } from "zod";

/** Every Gatekeeper tool returns this envelope as MCP structured content. */
export const ToolResultSchema = z.object({
  status: z.enum(["ok", "pending_approval", "denied", "unauthenticated", "not_found", "invalid", "conflict", "error"]),
  message: z.string(),
  data: z.unknown().optional(),
  approvalId: z.string().optional(),
  authorization: z
    .object({
      effect: z.enum(["allow", "deny", "requires_approval"]),
      code: z.string(),
      reason: z.string(),
    })
    .optional(),
  correlationId: z.string(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ToolStatus = ToolResult["status"];
