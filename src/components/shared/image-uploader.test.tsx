import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ImageUploader, type UploadedImage } from "@/components/shared/image-uploader";

function images(count: number): UploadedImage[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `/uploads/${i}.webp`,
    preview: `/uploads/${i}.webp`,
  }));
}

function imageFile(options: { type?: string; size?: number } = {}) {
  const file = new File(["x"], "photo.jpg", { type: options.type ?? "image/jpeg" });
  if (options.size !== undefined) {
    Object.defineProperty(file, "size", { value: options.size });
  }
  return file;
}

beforeAll(() => {
  // jsdom 未实现 createObjectURL
  Object.defineProperty(URL, "createObjectURL", {
    value: () => "blob:preview",
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImageUploader", () => {
  it("renders existing images with cover badge and usage counter", () => {
    render(
      <ImageUploader
        images={images(2)}
        onChange={vi.fn()}
        category="rental"
        coverIndex={0}
        onCoverChange={vi.fn()}
      />,
    );

    expect(screen.getByAltText("预览 1")).toBeInTheDocument();
    expect(screen.getByAltText("预览 2")).toBeInTheDocument();
    expect(screen.getByText("封面")).toBeInTheDocument();
    expect(screen.getByText("设为封面")).toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.textContent === "2/9 · 最大10MB"),
    ).toBeInTheDocument();
  });

  it("removes an image and resets the cover when the cover is deleted", () => {
    const onChange = vi.fn();
    const onCoverChange = vi.fn();
    render(
      <ImageUploader
        images={images(2)}
        onChange={onChange}
        category="rental"
        coverIndex={0}
        onCoverChange={onCoverChange}
      />,
    );

    fireEvent.click(screen.getAllByTitle("删除")[0]);

    expect(onChange).toHaveBeenCalledWith([images(2)[1]]);
    expect(onCoverChange).toHaveBeenCalledWith(0);
  });

  it("shifts the cover index when an earlier image is removed", () => {
    const onCoverChange = vi.fn();
    render(
      <ImageUploader
        images={images(3)}
        onChange={vi.fn()}
        category="rental"
        coverIndex={2}
        onCoverChange={onCoverChange}
      />,
    );

    fireEvent.click(screen.getAllByTitle("删除")[0]);

    expect(onCoverChange).toHaveBeenCalledWith(1);
  });

  it("reorders images and keeps the cover attached via move buttons", () => {
    const onChange = vi.fn();
    const onCoverChange = vi.fn();
    render(
      <ImageUploader
        images={images(2)}
        onChange={onChange}
        category="rental"
        coverIndex={1}
        onCoverChange={onCoverChange}
      />,
    );

    fireEvent.click(screen.getAllByTitle("上移")[0]);

    expect(onChange).toHaveBeenCalledWith([images(2)[1], images(2)[0]]);
    expect(onCoverChange).toHaveBeenCalledWith(0);
  });

  it("moves an image down and shifts the cover index", () => {
    const onChange = vi.fn();
    const onCoverChange = vi.fn();
    render(
      <ImageUploader
        images={images(2)}
        onChange={onChange}
        category="rental"
        coverIndex={0}
        onCoverChange={onCoverChange}
      />,
    );

    fireEvent.click(screen.getAllByTitle("下移")[0]);

    expect(onChange).toHaveBeenCalledWith([images(2)[1], images(2)[0]]);
    expect(onCoverChange).toHaveBeenCalledWith(1);
  });

  it("uploads valid selections immediately and appends server tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        assetId: "asset-1",
        access: "PUBLIC",
        url: "http://localhost:9100/campus-public/public/products/u1/x.webp",
        mimeType: "image/webp",
        sizeBytes: 1024,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onChange = vi.fn();
    render(<ImageUploader images={[]} onChange={onChange} category="product" />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [imageFile()] } });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0][0] as UploadedImage[];
    expect(next).toHaveLength(1);
    // 选图即上传：url 为服务端 token（公开 URL / asset 引用），成功后才进入列表
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/upload/images",
      expect.objectContaining({ method: "POST" }),
    );
    expect(next[0].url).toBe("http://localhost:9100/campus-public/public/products/u1/x.webp");
    expect(next[0].preview).toBe("blob:preview");

    vi.unstubAllGlobals();
  });

  it("keeps failed uploads out of the list and surfaces the error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: "存储空间不足，请删除旧图片后再试" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onChange = vi.fn();
    render(<ImageUploader images={[]} onChange={onChange} category="product" />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [imageFile()] } });

    expect(await screen.findByText("存储空间不足，请删除旧图片后再试")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("rejects selections beyond the remaining slots", async () => {
    const onChange = vi.fn();
    // verification 限 2 张，已有 1 张时一次选 2 张即超限
    render(<ImageUploader images={images(1)} onChange={onChange} category="verification" />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [imageFile(), imageFile()] },
    });

    expect(await screen.findByText("最多只能上传2张图片")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects unsupported file types", async () => {
    const onChange = vi.fn();
    render(<ImageUploader images={[]} onChange={onChange} category="product" />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [imageFile({ type: "image/gif" })] } });

    expect(await screen.findByText("仅支持JPG、PNG和WebP格式")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects oversized files", async () => {
    const onChange = vi.fn();
    render(<ImageUploader images={[]} onChange={onChange} category="avatar" />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [imageFile({ size: 6 * 1024 * 1024 })] } });

    expect(await screen.findByText("图片大小不能超过5MB")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides the upload tile once the category limit is reached", () => {
    render(<ImageUploader images={images(1)} onChange={vi.fn()} category="avatar" />);

    expect(screen.queryByText("点击上传")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
