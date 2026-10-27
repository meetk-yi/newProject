import { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../domain/errors.js";
import { calculateDiscount } from "../../domain/policies.js";

export class DiscountUseCases {
  constructor(private readonly database: PrismaClient) {}

  async validate(input: { userId: string; subtotalCents: number; codes: string[] }) {
    const user = await this.database.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new NotFoundError("User");

    const discounts = await this.database.discount.findMany({
      where: { code: { in: input.codes } },
    });
    if (discounts.length !== input.codes.length) {
      throw new ConflictError("One or more discount codes do not exist");
    }

    let discountCents = 0;
    for (const [index, code] of input.codes.entries()) {
      const discount = discounts.find((candidate) => candidate.code === code)!;
      if (
        !discount.active ||
        (discount.expiresAt && discount.expiresAt <= new Date()) ||
        (discount.maxUses !== null && discount.uses >= discount.maxUses) ||
        (discount.allowedTiers.length > 0 && !discount.allowedTiers.includes(user.tier))
      ) {
        throw new ConflictError(`Discount ${code} is not valid for this user`);
      }
      if (
        index > 0 &&
        (!discount.stackable ||
          !discounts.find((candidate) => candidate.code === input.codes[index - 1])?.stackable)
      ) {
        throw new ConflictError("Discounts cannot be combined");
      }
      discountCents += calculateDiscount(
        input.subtotalCents,
        discount.percentOff,
        discount.minimumCents,
      );
    }

    const appliedDiscountCents = Math.min(discountCents, input.subtotalCents);
    return {
      valid: true,
      discountCents: appliedDiscountCents,
      totalCents: input.subtotalCents - appliedDiscountCents,
    };
  }
}
