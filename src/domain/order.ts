import { randomUUID } from "node:crypto";
import { ConflictError } from "./errors.js";
import { DomainEvent, domainEvent } from "./events.js";
import { Money } from "./money.js";

export type OrderState = "PLACED" | "PARTIALLY_REFUNDED" | "REFUNDED";

export class OrderAggregate {
  private constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly total: Money,
    public refunded: Money,
    public state: OrderState,
    private readonly changes: DomainEvent[],
  ) {}

  static place(input: {
    id?: string;
    userId: string;
    subtotal: Money;
    discount: Money;
    tax: Money;
  }): OrderAggregate {
    const netSubtotal = input.subtotal.subtract(input.discount);
    if (input.subtotal.cents < 0 || input.discount.cents < 0 || input.discount.cents > input.subtotal.cents || input.tax.cents < 0) {
      throw new ConflictError("Order amounts violate pricing invariants");
    }
    const total = netSubtotal.add(input.tax);
    const id = input.id ?? randomUUID();
    return new OrderAggregate(id, input.userId, total, Money.of(0, total.currency), "PLACED", [
      domainEvent("order.placed", id, { userId: input.userId, totalCents: total.cents }),
    ]);
  }

  refund(amount: Money): void {
    if (this.state === "REFUNDED" || amount.cents <= 0) throw new ConflictError("Order cannot accept this refund");
    const refunded = this.refunded.add(amount);
    if (refunded.cents > this.total.cents) throw new ConflictError("Refund exceeds refundable order balance");
    this.refunded = refunded;
    this.state = refunded.cents === this.total.cents ? "REFUNDED" : "PARTIALLY_REFUNDED";
    this.changes.push(domainEvent("order.refunded", this.id, {
      amountCents: amount.cents, refundedCents: refunded.cents, status: this.state,
    }));
  }

  pullEvents(): DomainEvent[] {
    return this.changes.splice(0, this.changes.length);
  }
}
