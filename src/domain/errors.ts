export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string) {
    super(`${entity} was not found`, "NOT_FOUND", 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super("Insufficient wallet funds", "INSUFFICIENT_FUNDS", 422);
  }
}
