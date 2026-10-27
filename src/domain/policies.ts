import { DomainError } from "./errors.js";

export const calculateTax = (taxableCents: number, rateBasisPoints = 825): number => {
  if (!Number.isSafeInteger(taxableCents) || taxableCents < 0 ||
      !Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new DomainError("Tax inputs must be non-negative integer amounts", "INVALID_TAX_INPUT");
  }
  return Math.round((taxableCents * rateBasisPoints) / 10_000);
};

export const calculateDiscount = (
  subtotalCents: number,
  percentOff: number,
  minimumCents: number,
): number => {
  if (subtotalCents < minimumCents) throw new DomainError("Order does not meet discount minimum", "DISCOUNT_MINIMUM");
  if (percentOff < 0 || percentOff > 100) throw new DomainError("Invalid discount percentage", "INVALID_DISCOUNT");
  return Math.floor((subtotalCents * percentOff) / 100);
};

export const calculateBillableWeight = (
  actualWeightGrams: number,
  lengthCm: number,
  widthCm: number,
  heightCm: number,
  divisor = 5000,
): number => Math.max(actualWeightGrams, Math.ceil((lengthCm * widthCm * heightCm * 1000) / divisor));

export const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(`${label} must be a positive integer`, "INVALID_QUANTITY");
  }
};
