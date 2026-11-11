import { z } from "zod";

/**
 * Customer IDs look like CUST-XXXXX, where X is a digit (e.g. CUST-00042).
 * The pattern is anchored and case-sensitive on purpose: "cust-00042",
 * " CUST-00042" and "CUST-000421" are all rejected, not normalised.
 */
export const CUSTOMER_ID_PATTERN = /^CUST-\d{5}$/;

export const CustomerId = z
  .string({ error: "customer_id must be a string" })
  .regex(CUSTOMER_ID_PATTERN, { error: "customer_id must match the format CUST-XXXXX (5 digits), e.g. CUST-00042" })
  .describe("Customer identifier in the format CUST-XXXXX (5 digits)");

/** Largest refund one call may issue. This guards against fat-finger and prompt-injected values. */
export const MAX_REFUND_AMOUNT = 10_000;

export const RefundAmount = z
  .number({ error: "amount must be a number (strings such as \"10.00\" are not accepted)" })
  .positive({ error: "amount must be greater than 0" })
  .max(MAX_REFUND_AMOUNT, { error: `amount must not exceed ${MAX_REFUND_AMOUNT}` })
  .refine((n) => Number.isInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, {
    error: "amount must have at most 2 decimal places",
  })
  .describe(`Refund amount in USD, positive, at most 2 decimal places, max ${MAX_REFUND_AMOUNT}`);

export const RefundReason = z
  .string({ error: "reason must be a string" })
  // Trim before the length check, so ten spaces cannot satisfy the minimum length.
  .trim()
  .min(10, { error: "reason must be at least 10 characters (excluding leading/trailing whitespace)" })
  .max(1000, { error: "reason must be at most 1000 characters" })
  .describe("Human-readable justification for the refund (10-1000 characters)");

// strictObject rejects unknown keys, so callers cannot smuggle in extra fields
// (e.g. "approved": true) that a downstream system might honour.
export const GetCustomerRecordInput = z.strictObject({
  customer_id: CustomerId,
});

export const TriggerRefundInput = z.strictObject({
  customer_id: CustomerId,
  amount: RefundAmount,
  reason: RefundReason,
});

export type GetCustomerRecordArgs = z.infer<typeof GetCustomerRecordInput>;
export type TriggerRefundArgs = z.infer<typeof TriggerRefundInput>;

/** Converts a Zod schema into the JSON Schema object that tools/list advertises. */
export function toInputSchema(schema: z.ZodType): { type: "object"; [k: string]: unknown } {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: "object" };
}

/** Shapes Zod issues into a compact, client-friendly `data` payload for JSON-RPC errors. */
export function formatIssues(error: z.ZodError): Array<{ field: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message,
    code: issue.code,
  }));
}
