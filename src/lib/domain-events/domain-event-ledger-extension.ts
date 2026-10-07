import { Prisma } from "@prisma/client";

export class DomainEventAppendOnlyViolationError extends Error {
  readonly code = "DOMAIN_EVENT_APPEND_ONLY";

  constructor(readonly operation: string) {
    super(`DOMAIN_EVENT_APPEND_ONLY: ${operation}`);
    this.name = "DomainEventAppendOnlyViolationError";
  }
}

const FORBIDDEN_DOMAIN_EVENT_MUTATIONS = new Set([
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

export function isForbiddenDomainEventMutation(operation: string): boolean {
  return FORBIDDEN_DOMAIN_EVENT_MUTATIONS.has(operation);
}

/**
 * Business Prisma client append-only guard for the authoritative DomainEvent
 * ledger. This module intentionally has no dependency on the DomainEvent writer
 * or async queue so prisma.ts can compose it without creating a module cycle.
 */
export const domainEventLedgerExtension = Prisma.defineExtension((client) =>
  client.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (model === "DomainEvent" && isForbiddenDomainEventMutation(operation)) {
            throw new DomainEventAppendOnlyViolationError(operation);
          }
          return query(args);
        },
      },
    },
  }),
);
