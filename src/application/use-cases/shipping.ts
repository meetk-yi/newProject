import { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../domain/errors.js";
import { assertPositiveInteger, calculateBillableWeight } from "../../domain/policies.js";

type ShippingItem = { productId: string; quantity: number };

export class ShippingUseCases {
  constructor(private readonly database: PrismaClient) {}

  async calculate(input: { items: ShippingItem[] }) {
    const productIds = [...new Set(input.items.map((item) => item.productId))];
    const products = await this.database.product.findMany({
      where: { id: { in: productIds }, active: true },
    });
    if (products.length !== productIds.length) throw new NotFoundError("Product");
    const productsById = new Map(products.map((product) => [product.id, product]));

    let billableWeightGrams = 0;
    for (const item of input.items) {
      assertPositiveInteger(item.quantity, "quantity");
      const product = productsById.get(item.productId)!;
      billableWeightGrams +=
        calculateBillableWeight(
          product.weightGrams,
          product.lengthCm,
          product.widthCm,
          product.heightCm,
        ) * item.quantity;
    }

    const rates = [
      {
        carrier: "ParcelOne",
        service: "ground",
        amountCents: 500 + Math.ceil(billableWeightGrams / 1000) * 125,
      },
      {
        carrier: "AirSwift",
        service: "express",
        amountCents: 1200 + Math.ceil(billableWeightGrams / 500) * 210,
      },
    ];
    await this.database.shipmentQuote.createMany({
      data: rates.map((rate) => ({ ...rate, billableWeightGrams })),
    });
    return { billableWeightGrams, rates };
  }
}
