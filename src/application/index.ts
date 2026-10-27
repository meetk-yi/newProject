import { PrismaClient } from "@prisma/client";
import { DiscountUseCases } from "./use-cases/discounts.js";
import { DisputeUseCases } from "./use-cases/disputes.js";
import { InventoryUseCases } from "./use-cases/inventory.js";
import { InvoiceUseCases } from "./use-cases/invoices.js";
import { OrderUseCases } from "./use-cases/orders.js";
import { ShippingUseCases } from "./use-cases/shipping.js";
import { SubscriptionUseCases } from "./use-cases/subscriptions.js";
import { WalletUseCases } from "./use-cases/wallet.js";

export function createCommerceUseCases(database: PrismaClient) {
  const orders = new OrderUseCases(database);
  const inventory = new InventoryUseCases(database);
  const discounts = new DiscountUseCases(database);
  const wallets = new WalletUseCases(database);
  const invoices = new InvoiceUseCases(database);
  const subscriptions = new SubscriptionUseCases(database);
  const shipping = new ShippingUseCases(database);
  const disputes = new DisputeUseCases(database);

  return {
    checkout: orders.checkout.bind(orders),
    refund: orders.refund.bind(orders),
    allocate: inventory.allocate.bind(inventory),
    validateDiscount: discounts.validate.bind(discounts),
    redeemLoyalty: wallets.redeemLoyalty.bind(wallets),
    transfer: wallets.transfer.bind(wallets),
    generateInvoice: invoices.generate.bind(invoices),
    renewSubscription: subscriptions.renew.bind(subscriptions),
    calculateShipping: shipping.calculate.bind(shipping),
    openDispute: disputes.open.bind(disputes),
  };
}

export type CommerceUseCases = ReturnType<typeof createCommerceUseCases>;
