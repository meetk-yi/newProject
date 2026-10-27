import { DomainError } from "./errors.js";

export class Money {
  private constructor(
    public readonly cents: number,
    public readonly currency: string,
  ) {}

  static of(cents: number, currency = "USD"): Money {
    if (!Number.isSafeInteger(cents))
      throw new DomainError("Money must use integer minor units", "INVALID_MONEY");
    if (!/^[A-Z]{3}$/.test(currency))
      throw new DomainError("Currency must be an ISO 4217 code", "INVALID_CURRENCY");
    return new Money(cents, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents - other.cents, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new DomainError("Currency mismatch", "CURRENCY_MISMATCH");
  }
}
