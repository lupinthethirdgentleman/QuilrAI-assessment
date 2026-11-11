import { randomUUID } from "node:crypto";

export interface CustomerRecord {
  customer_id: string;
  name: string;
  email: string;
  tier: "standard" | "premium" | "enterprise";
  status: "active" | "suspended";
  lifetime_value: number;
  refunded_total: number;
}

export interface RefundRecord {
  refund_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  status: "processed";
  created_at: string;
}

/** In-memory stand-in for a CRM and billing backend. */
export class CustomerStore {
  private readonly customers = new Map<string, CustomerRecord>();
  private readonly refunds: RefundRecord[] = [];

  constructor(seed: CustomerRecord[] = DEFAULT_CUSTOMERS) {
    for (const c of seed) this.customers.set(c.customer_id, { ...c });
  }

  get(customerId: string): CustomerRecord | undefined {
    const c = this.customers.get(customerId);
    return c ? { ...c } : undefined;
  }

  refund(customerId: string, amount: number, reason: string): RefundRecord {
    const customer = this.customers.get(customerId);
    if (!customer) throw new DomainError(`Customer ${customerId} not found`);
    if (customer.status !== "active") throw new DomainError(`Customer ${customerId} is ${customer.status}; refunds are blocked`);
    // Work in cents so the arithmetic is exact.
    const refundable = Math.round((customer.lifetime_value - customer.refunded_total) * 100);
    const requested = Math.round(amount * 100);
    if (requested > refundable) {
      throw new DomainError(`Refund of ${amount.toFixed(2)} exceeds refundable balance of ${(refundable / 100).toFixed(2)}`);
    }
    customer.refunded_total = (Math.round(customer.refunded_total * 100) + requested) / 100;
    const record: RefundRecord = {
      refund_id: `RF-${randomUUID()}`,
      customer_id: customerId,
      amount: requested / 100,
      reason,
      status: "processed",
      created_at: new Date().toISOString(),
    };
    this.refunds.push(record);
    return record;
  }
}

/**
 * A business-rule failure: the input was valid, but the operation is not allowed.
 * These come back as tool results with isError: true, NOT as JSON-RPC protocol
 * errors, so the model can see why and adjust (per the MCP spec).
 */
export class DomainError extends Error {}

const DEFAULT_CUSTOMERS: CustomerRecord[] = [
  { customer_id: "CUST-00001", name: "Ada Lovelace", email: "ada@example.com", tier: "enterprise", status: "active", lifetime_value: 12500, refunded_total: 0 },
  { customer_id: "CUST-00042", name: "Alan Turing", email: "alan@example.com", tier: "premium", status: "active", lifetime_value: 980.5, refunded_total: 120 },
  { customer_id: "CUST-31337", name: "Grace Hopper", email: "grace@example.com", tier: "standard", status: "suspended", lifetime_value: 210, refunded_total: 0 },
];
