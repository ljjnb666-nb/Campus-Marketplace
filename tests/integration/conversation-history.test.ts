// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("conversation history PostgreSQL regression", () => {
  let db: PrismaClient;
  let repo: typeof import("@/repositories/conversation-repository");
  const tag = randomUUID();
  const users = [`history-a-${tag}`, `history-b-${tag}`, `history-c-${tag}`];
  const conversations = [`history-one-${tag}`, `history-other-${tag}`];

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    vi.doMock("@/lib/prisma", () => ({ prisma: db }));
    repo = await import("@/repositories/conversation-repository");
    await db.campus.create({ data: { id: tag, name: tag, slug: tag, schoolName: "Fixture" } });
    await db.user.createMany({ data: users.map((id) => ({
      id, email: `${id}@test.invalid`, passwordHash: "fixture", name: id, schoolName: "Fixture", campusId: tag,
    })) });
    await db.conversation.create({ data: { id: conversations[0],
      participants: { create: users.slice(0, 2).map((userId) => ({ userId })) },
      messages: { create: Array.from({ length: 105 }, (_, index) => ({
        id: `${tag}-${index.toString().padStart(3, "0")}`, content: `message-${index}`,
        senderId: users[1], createdAt: new Date("2026-10-23T00:00:00.000Z"),
      })) },
    } });
    await db.conversation.create({ data: { id: conversations[1],
      participants: { create: [{ userId: users[2] }] },
      messages: { create: { id: `foreign-${tag}`, senderId: users[2], content: "private" } },
    } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.conversation.deleteMany({ where: { id: { in: conversations } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.campus.deleteMany({ where: { id: tag } });
    await db.$disconnect();
    vi.doUnmock("@/lib/prisma");
  });

  it("paginates tied timestamps without missing or duplicating rows", async () => {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.getConversationDetailPayload(conversations[0], users[0], cursor, 20);
      expect(page).not.toBeNull();
      found.push(...page!.messages.map((row) => row.id));
      cursor = page!.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toHaveLength(105);
    expect(new Set(found).size).toBe(105);
  });
  it("rejects outsiders and cursors belonging to another conversation", async () => {
    expect(await repo.getConversationDetailPayload(conversations[0], users[2])).toBeNull();
    expect(await repo.getConversationDetailPayload(conversations[0], users[0], `foreign-${tag}`)).toBeNull();
  });
  it("selects the newest summary and counts unread conversations in PostgreSQL", async () => {
    await db.message.updateMany({ where: { conversationId: conversations[0] }, data: { isRead: false } });
    const list = await repo.getConversationListItems(users[0]);
    expect(list).toHaveLength(1);
    expect(list[0].lastMessageContent).toBe("message-104");
    expect(await repo.getUnreadConversationCount(users[0])).toBe(1);
    expect(await repo.getUnreadConversationCount(users[1])).toBe(0);
  });
});
