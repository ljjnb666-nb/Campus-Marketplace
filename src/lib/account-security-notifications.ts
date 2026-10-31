import type { Prisma } from "@prisma/client";
import { emitNotificationTx } from "@/lib/notifications/notification-service";

export type AccountSecurityEvent = "PASSWORD_CHANGED" | "PASSWORD_RESET" | "SESSIONS_REVOKED" | "MFA_ENABLED" | "MFA_DISABLED";
export function emitAccountSecurityNoticeTx(tx: Prisma.TransactionClient, userId: string, event: AccountSecurityEvent, occurrenceId: string) {
  return emitNotificationTx(tx, { kind: "ACCOUNT_SECURITY_EVENT", recipientUserId: userId,
    dedupeKey: `ACCOUNT_SECURITY_EVENT:${occurrenceId}:${userId}`, payload: { event, occurrenceId } });
}
