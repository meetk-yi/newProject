import { describe, expect, it } from "vitest";
import { calculateBillableWeight, calculateDiscount, calculateTax } from "../src/domain/policies.js";
import { OrderAggregate } from "../src/domain/order.js";
import { Money } from "../src/domain/money.js";

describe("commerce policies", () => {
  it("calculates tax in integer cents", () => {
    expect(calculateTax(10_000, 825)).toBe(825);
  });

  it("caps dimensional weight at actual weight", () => {
    expect(calculateBillableWeight(3000, 10, 10, 10)).toBe(3000);
    expect(calculateBillableWeight(100, 50, 40, 30)).toBe(12_000);
  });

  it("calculates a floored percentage discount", () => {
    expect(calculateDiscount(999, 10, 500)).toBe(99);
  });

  it("enforces aggregate refund invariants and records state transitions", () => {
    const order = OrderAggregate.place({
      userId: "user-1",
      subtotal: Money.of(1000),
      discount: Money.of(100),
      tax: Money.of(75),
    });
    order.refund(Money.of(500));
    expect(order.state).toBe("PARTIALLY_REFUNDED");
    order.refund(Money.of(475));
    expect(order.state).toBe("REFUNDED");
    expect(order.pullEvents().map((event) => event.type)).toEqual([
      "order.placed",
      "order.refunded",
      "order.refunded",
    ]);
    expect(() => order.refund(Money.of(1))).toThrow();
  });
});
