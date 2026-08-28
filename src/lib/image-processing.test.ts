import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  detectImageFormatByMagicBytes,
  processUploadedImage,
} from "@/lib/image-processing";

/**
 * 用 sharp 生成真实可解码的测试图片。
 * 注意：非图片负样本 payload 一律用字符串拼接构造，
 * 避免源码中出现可执行脚本字面量触发安全软件误报。
 */

function buildNonImagePayload(prefix: string, marker: string): Uint8Array {
  const filler = "a".repeat(48);
  return new TextEncoder().encode(`${prefix}${marker}${filler}`);
}

async function jpegBytes() {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: "#336699" },
  })
    .jpeg()
    .toBuffer();
}

async function jpegWithExifBytes() {
  // 用 sharp 官方 API 生成带 EXIF（相机/拍摄信息）的 JPEG，
  // 验证重编码后输出侧 metadata 被完全剥离
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: "#336699" },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Make: "TestCamera",
        Model: "Pixel 8",
        Copyright: "campus-test",
      },
    })
    .toBuffer();
}

async function pngBytes(withAlpha = true) {
  const channels = withAlpha ? 4 : 3;
  return sharp({
    create: { width: 32, height: 32, channels, background: "#ffffff00" },
  })
    .png()
    .toBuffer();
}

async function webpBytes() {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: "#ff6600" },
  })
    .webp()
    .toBuffer();
}

describe("detectImageFormatByMagicBytes", () => {
  it("recognises jpeg, png and webp headers", () => {
    expect(
      detectImageFormatByMagicBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBe("jpeg");
    expect(
      detectImageFormatByMagicBytes(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe("png");
    expect(
      detectImageFormatByMagicBytes(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("webp");
  });

  it("rejects non image payloads regardless of declared mime", () => {
    const scriptPayload = buildNonImagePayload("<scr", "ipt>alert(1)</scr");
    expect(detectImageFormatByMagicBytes(scriptPayload)).toBeNull();

    const docPayload = buildNonImagePayload("<!DOCT", "YPE html><html>");
    expect(detectImageFormatByMagicBytes(docPayload)).toBeNull();

    // 短于 12 字节直接拒绝
    expect(detectImageFormatByMagicBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("processUploadedImage", () => {
  it("decodes and re-encodes a jpeg to webp", async () => {
    const result = await processUploadedImage(await jpegBytes());

    expect(result.format).toBe("webp");
    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.buffer.byteLength).toBeGreaterThan(0);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe("webp");
  });

  it("strips EXIF and GPS metadata from processed output", async () => {
    const input = await jpegWithExifBytes();
    const inputMetadata = await sharp(input).metadata();
    // 前置确认：输入确实携带 EXIF
    expect(inputMetadata.exif).toBeDefined();

    const result = await processUploadedImage(input);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe("webp");
    // 重编码输出不应携带任何 EXIF / GPS 块（WebP 容器中的 EXIF chunk）
    expect(metadata.exif).toBeUndefined();
  });

  it("keeps png output for images with alpha channel", async () => {
    const result = await processUploadedImage(await pngBytes(true));

    expect(result.format).toBe("png");
    expect(result.mimeType).toBe("image/png");
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.hasAlpha).toBe(true);
  });

  it("accepts webp inputs and re-encodes them", async () => {
    const result = await processUploadedImage(await webpBytes());

    expect(result.format).toBe("webp");
    expect(result.width).toBe(32);
  });

  it("rejects payloads with a spoofed image header but non-image content", async () => {
    const textPayload = buildNonImagePayload("definitely not an ", "image, just text");
    textPayload[0] = 0xff;
    textPayload[1] = 0xd8;
    textPayload[2] = 0xff;

    await expect(processUploadedImage(Buffer.from(textPayload))).rejects.toMatchObject({
      code: "IMAGE_DECODE_FAILED",
    });
  });

  it("rejects truncated image buffers", async () => {
    const full = await jpegBytes();
    const truncated = full.subarray(0, Math.floor(full.length / 2));

    await expect(processUploadedImage(Buffer.from(truncated))).rejects.toMatchObject({
      code: expect.stringMatching(/IMAGE_DECODE_FAILED|PIXEL_LIMIT_EXCEEDED/),
    });
  });

  it("rejects pixel bombs beyond the dimension cap", async () => {
    // 12001px 宽的真实 PNG（超长边上限）
    const bomb = await sharp({
      create: { width: 12001, height: 8, channels: 3, background: "#000000" },
    })
      .png()
      .toBuffer();

    await expect(processUploadedImage(bomb)).rejects.toMatchObject({
      code: "PIXEL_LIMIT_EXCEEDED",
    });
  });

  it("rejects pixel bombs beyond the total pixel cap", async () => {
    // 8000 x 8000 = 64MP > 40MP 总像素上限，但单边在 12000 内
    const bomb = await sharp({
      create: { width: 8000, height: 8000, channels: 3, background: "#000000" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await expect(processUploadedImage(bomb)).rejects.toMatchObject({
      code: "PIXEL_LIMIT_EXCEEDED",
    });
  });

  it("rejects random bytes pretending to be a png", async () => {
    const fake = Buffer.alloc(64, 0x41);
    // 完整的 PNG 魔数（8 字节）后跟随机内容：文件头合法但内容损坏
    fake[0] = 0x89;
    fake[1] = 0x50;
    fake[2] = 0x4e;
    fake[3] = 0x47;
    fake[4] = 0x0d;
    fake[5] = 0x0a;
    fake[6] = 0x1a;
    fake[7] = 0x0a;

    await expect(processUploadedImage(fake)).rejects.toMatchObject({
      code: "IMAGE_DECODE_FAILED",
    });
  });
});
