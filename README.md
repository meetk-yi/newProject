# Commerce Ledger API

A TypeScript/Fastify service for order checkout, inventory, promotions, wallets, loyalty, subscriptions, shipping, invoices, and disputes. The project keeps HTTP, application, domain policy, and persistence responsibilities separate and uses PostgreSQL transactions for state changes.

## Architecture

```text
src/
  config/          Environment parsing and runtime configuration
  domain/          Business errors and pure domain policies
  application/
    use-cases/     Focused order, wallet, inventory, shipping, and other use cases
    shared/        Reusable application transaction coordination
    index.ts       Composition root for application use cases
  infrastructure/  Prisma database client
  presentation/    Fastify HTTP routes and Zod request schemas
  app.ts           Dependency composition and error mapping
  main.ts          Process lifecycle
prisma/
  schema.prisma    PostgreSQL persistence model
test/              Unit tests for deterministic domain policies
```

Each application use case is grouped by business capability rather than exposed through a single service with unrelated responsibilities. The manual composition function in `application/index.ts` wires use cases into the presentation layer; infrastructure dependencies are passed in at the application boundary. Amounts are represented as integer minor currency units. Inventory allocation and wallet debits use conditional database updates, with serializable transactions for operations involving concurrent state changes. Invoice and dispute side effects are recorded in an outbox table so a worker can process them reliably; this repository intentionally does not pretend an external document or payment provider is integrated.

## Requirements and setup

- Node.js 20+
- PostgreSQL 15+

```sh
npm install
cp .env.example .env
# Set DATABASE_URL to a PostgreSQL database you can migrate.
npm run db:generate
npm run db:migrate
npm run dev
```

For production, build and deploy migrations before starting:

```sh
npm run db:deploy
npm run build
npm start
```

The service validates environment configuration on startup with Zod. Request bodies and path parameters are also parsed with Zod. Logs are structured JSON through Fastify/Pino. Do not expose production database credentials in `.env` files committed to source control.

## Database

Prisma models define users, products, inventory, orders and lines, discounts, wallet ledger entries, refunds, loyalty lots, invoices, subscriptions, shipping quotes, disputes, and outbox events. `npm run db:migrate` creates a development migration interactively; commit generated migration directories to version-control. Production deployments should use `npm run db:deploy`.

The API uses serializable transactions for checkout, refunds, allocations, transfers, redemption, and subscription renewal, retrying serialization conflicts up to three total attempts. Wallet transfer supports idempotent replay through the required key. A card provider cannot be safely selected without provider credentials and integration requirements; card checkout therefore fails explicitly rather than falsely reporting a successful charge. Implement a payment-provider adapter before enabling card checkout.

## API

All endpoints are under `/api/v1`. Request and response monetary fields are integer cents. UUID fields require UUID strings. Errors use `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path                     | Purpose                                                                                                                                                                                                          |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/orders/checkout`       | Validate line items and optional coupons, reserve stock, calculate tax, place the order, and debit a wallet. Card payment returns `503 PAYMENT_PROVIDER_UNAVAILABLE` until a real gateway adapter is configured. |
| POST   | `/orders/:id/refund`     | Apply a partial/full refund and reverse wallet ledger entries; restocks on full refund.                                                                                                                          |
| POST   | `/inventory/allocate`    | Atomically reserve inventory for a bounded TTL.                                                                                                                                                                  |
| POST   | `/discounts/validate`    | Check active dates, usage limits, user tier, minimums, and stacking rules.                                                                                                                                       |
| POST   | `/loyalty/redeem`        | Consume earliest-expiring point lots and credit the USD wallet at one cent per point.                                                                                                                            |
| POST   | `/wallet/transfer`       | Perform a same-currency double-entry transfer with an idempotency key.                                                                                                                                           |
| GET    | `/invoices/:id/generate` | Queue invoice generation via an outbox event and return HTTP 202. The path parameter is the order ID.                                                                                                            |
| POST   | `/subscriptions/renew`   | Charge the subscriber wallet, advance billing, or enter/expire a seven-day grace period.                                                                                                                         |
| POST   | `/shipping/calculate`    | Calculate two sample carrier rates using actual versus dimensional weight. Replace sample rates with carrier adapters for production.                                                                            |
| POST   | `/disputes/open`         | Open an order dispute, freeze the refundable balance as escrow, and enqueue an outbox event.                                                                                                                     |

### Example requests

```json
POST /api/v1/orders/checkout
{
  "userId": "00000000-0000-4000-8000-000000000001",
  "items": [{ "productId": "00000000-0000-4000-8000-000000000002", "quantity": 2 }],
  "payment": { "method": "wallet", "walletId": "00000000-0000-4000-8000-000000000003" }
}
```

```json
POST /api/v1/wallet/transfer
{
  "fromWalletId": "00000000-0000-4000-8000-000000000003",
  "toWalletId": "00000000-0000-4000-8000-000000000004",
  "amountCents": 2500,
  "idempotencyKey": "transfer-2025-000001"
}
```

## Testing

```sh
npm test
npm run test:integration
npm run typecheck
npm run build
npm run format:check
```

Domain policy tests are independent of PostgreSQL. Set `TEST_DATABASE_URL` to a disposable migrated PostgreSQL database to enable the PostgreSQL integration test. Extend this suite with transaction-level scenarios for serialization conflicts, unique constraints, rollbacks, expiration, and idempotent retries.

Run `npm run format` to apply the repository's Prettier configuration.

## Operational notes

- Configure `DATABASE_URL`, `PORT`, `HOST`, and `LOG_LEVEL` through the deployment environment.
- Add authentication/authorization middleware before exposing user-scoped operations publicly.
- Use a worker that leases unprocessed `OutboxEvent` rows, retries failures, and marks successful events processed.
- Add payment gateway adapters and webhook signature verification before production card/refund settlement.
- Apply API rate limits, request size limits, monitoring, backups, and retention policies appropriate to the deployment.
