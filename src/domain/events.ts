export type DomainEvent<TPayload extends object = object> = {
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: TPayload;
};

export function domainEvent<TPayload extends object>(
  type: string,
  aggregateId: string,
  payload: TPayload,
): DomainEvent<TPayload> {
  return { type, aggregateId, occurredAt: new Date(), payload };
}
