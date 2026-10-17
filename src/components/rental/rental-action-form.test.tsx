import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RentalActionForm } from "@/components/rental/rental-action-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderEvidenceForm(action: (data: FormData) => Promise<{ success: boolean; message?: string }>) {
  const { container } = render(
    <RentalActionForm action={action} uploadCategory="handover" submitLabel="确认已交接">
      <input name="orderId" value="order-1" readOnly />
      <input type="file" name="photos" accept="image/png" multiple />
    </RentalActionForm>,
  );
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("RentalActionForm R09 independent evidence uploads", () => {
  it("sends >1MiB valid image through per-file API, then only a tiny asset token to Server Action", async () => {
    const action = vi.fn().mockResolvedValue({ success: true });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ success: true, assetId: "asset1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = renderEvidenceForm(action);
    const image = new File([new Uint8Array(2 * 1024 * 1024)], "evidence.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [image] } });
    fireEvent.click(screen.getByRole("button", { name: "确认已交接" }));

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(url).toBe("/api/upload/images");
    expect(opts.method).toBe("POST");
    expect(opts.body.get("category")).toBe("handover");
    expect((opts.body.get("file") as File).size).toBe(2 * 1024 * 1024);

    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get("orderId")).toBe("order-1");
    expect(sent.getAll("photos")).toEqual(["asset:asset1"]);
    expect([...sent.entries()].every(([, value]) => typeof value === "string")).toBe(true);
  });

  it("uploads multiple files separately, never accumulates binary data in a single Action request", async () => {
    const action = vi.fn().mockResolvedValue({ success: true });
    let seq = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ success: true, assetId: `asset${++seq}` }),
    })));
    const input = renderEvidenceForm(action);
    fireEvent.change(input, { target: { files: [
      new File([new Uint8Array(2 * 1024 * 1024)], "a.png", { type: "image/png" }),
      new File([new Uint8Array(3 * 1024 * 1024)], "b.png", { type: "image/png" }),
    ] } });
    fireEvent.click(screen.getByRole("button", { name: "确认已交接" }));

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.getAll("photos")).toEqual(["asset:asset1", "asset:asset2"]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect([...sent.values()].every((v) => typeof v === "string")).toBe(true);
  });

  it("does not submit the business action when uploading failed", async () => {
    const action = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: "对象存储不可用" }),
    }));
    const input = renderEvidenceForm(action);
    fireEvent.change(input, { target: { files: [
      new File(["content"], "evidence.png", { type: "image/png" }),
    ] } });
    fireEvent.click(screen.getByRole("button", { name: "确认已交接" }));

    expect(await screen.findByText("对象存储不可用")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
