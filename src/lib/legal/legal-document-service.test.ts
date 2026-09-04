import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  legalDocumentFindUnique,
  legalDocumentFindFirst,
  legalDocumentUpdate,
  legalDocumentCreate,
  transactionMock,
} = vi.hoisted(() => ({
  legalDocumentFindUnique: vi.fn(),
  legalDocumentFindFirst: vi.fn(),
  legalDocumentUpdate: vi.fn(),
  legalDocumentCreate: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    legalDocument: {
      findUnique: legalDocumentFindUnique,
      findFirst: legalDocumentFindFirst,
      update: legalDocumentUpdate,
      create: legalDocumentCreate,
    },
  },
  withTransaction: transactionMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  computeContentHash,
  createLegalDocument,
  publishLegalDocument,
  updateDraftLegalDocument,
} from "@/lib/legal/legal-document-service";

beforeEach(() => {
  legalDocumentFindUnique.mockReset();
  legalDocumentFindFirst.mockReset();
  legalDocumentUpdate.mockReset();
  legalDocumentCreate.mockReset();
  transactionMock.mockReset();
});

describe("computeContentHash（POLICY_HASH_STABLE）", () => {
  it("is stable for identical canonical content", () => {
    const content = "# 协议正文\n\n第一条 平台定位。";

    expect(computeContentHash(content)).toBe(computeContentHash(content));
  });

  it("is a sha-256 hex digest that changes with any content byte", () => {
    const base = "平台协议内容 v1";
    const modified = "平台协议内容 v2";

    const hash = computeContentHash(base);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(computeContentHash(modified));
  });
});

describe("publishLegalDocument（PUBLISHED_POLICY_IMMUTABLE）", () => {
  it("publishes a draft and stamps publishedAt", async () => {
    const draft = {
      id: "doc-1",
      type: "TERMS_OF_SERVICE",
      version: 1,
      status: "DRAFT",
      publishedAt: null,
    };
    legalDocumentFindUnique.mockResolvedValue(draft);
    legalDocumentFindFirst.mockResolvedValue(null);
    legalDocumentUpdate.mockResolvedValue({ ...draft, status: "PUBLISHED", publishedAt: new Date() });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: vi.fn().mockResolvedValue(0),
        legalDocument: {
          findUnique: legalDocumentFindUnique,
          findFirst: legalDocumentFindFirst,
          update: legalDocumentUpdate,
        },
      }),
    );

    const published = await publishLegalDocument("doc-1");

    expect(published.status).toBe("PUBLISHED");
    // 发布只允许改 status/publishedAt
    expect(legalDocumentUpdate).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: expect.objectContaining({ status: "PUBLISHED" }),
    });
  });

  it("refuses to republish a retired document", async () => {
    legalDocumentFindUnique.mockResolvedValue({
      id: "doc-1",
      status: "RETIRED",
      type: "TERMS_OF_SERVICE",
      version: 1,
    });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: vi.fn().mockResolvedValue(0),
        legalDocument: {
          findUnique: legalDocumentFindUnique,
          findFirst: legalDocumentFindFirst,
          update: legalDocumentUpdate,
        },
      }),
    );

    await expect(publishLegalDocument("doc-1")).rejects.toMatchObject({
      code: "LEGAL_DOCUMENT_ALREADY_PUBLISHED",
    });
  });

  it("refuses out-of-order version publication (ambiguity guard)", async () => {
    legalDocumentFindUnique.mockResolvedValue({
      id: "doc-1",
      status: "DRAFT",
      type: "TERMS_OF_SERVICE",
      version: 2,
    });
    legalDocumentFindFirst.mockResolvedValue({ version: 3 });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: vi.fn().mockResolvedValue(0),
        legalDocument: {
          findUnique: legalDocumentFindUnique,
          findFirst: legalDocumentFindFirst,
          update: legalDocumentUpdate,
        },
      }),
    );

    await expect(publishLegalDocument("doc-1")).rejects.toMatchObject({
      code: "LEGAL_DOCUMENT_ALREADY_PUBLISHED",
    });
  });
});

describe("updateDraftLegalDocument（不可变入口收敛）", () => {
  it("rejects content edits for published documents", async () => {
    legalDocumentFindUnique.mockResolvedValue({
      id: "doc-1",
      status: "PUBLISHED",
      type: "TERMS_OF_SERVICE",
      version: 1,
      publishedAt: new Date(),
    });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ legalDocument: { findUnique: legalDocumentFindUnique } }),
    );

    await expect(
      updateDraftLegalDocument("doc-1", { content: "篡改后的内容" }),
    ).rejects.toMatchObject({ code: "LEGAL_DOCUMENT_ALREADY_PUBLISHED" });
  });

  it("recomputes the content hash together with draft content edits", async () => {
    legalDocumentFindUnique.mockResolvedValue({
      id: "doc-1",
      status: "DRAFT",
      type: "TERMS_OF_SERVICE",
      version: 1,
      publishedAt: null,
    });
    legalDocumentUpdate.mockResolvedValue({ id: "doc-1" });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: vi.fn().mockResolvedValue(0),
        legalDocument: { findUnique: legalDocumentFindUnique, update: legalDocumentUpdate },
      }),
    );

    await updateDraftLegalDocument("doc-1", { content: "草稿新内容" });

    expect(legalDocumentUpdate).toHaveBeenCalledWith({
      where: { id: "doc-1" },
      data: expect.objectContaining({
        content: "草稿新内容",
        contentHash: computeContentHash("草稿新内容"),
      }),
    });
  });
});

describe("createLegalDocument", () => {
  it("stores the sha-256 hash of the canonical content", async () => {
    legalDocumentCreate.mockResolvedValue({ id: "doc-9" });

    await createLegalDocument({
      type: "PRIVACY_POLICY",
      version: 1,
      title: "隐私政策",
      content: "正文",
    });

    expect(legalDocumentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contentHash: computeContentHash("正文"),
        requiresAcceptance: true,
      }),
    });
  });
});
