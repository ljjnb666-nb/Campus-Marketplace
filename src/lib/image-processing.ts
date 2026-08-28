import sharp, { type Metadata, type Sharp } from "sharp";

/**
 * 图片内容安全处理管线：
 * 1. magic bytes 白名单（防 MIME 伪造）
 * 2. sharp 真实 decode（防损坏文件 / 伪装 polyglot）
 * 3. 像素上限（防 decompression bomb）
 * 4. autoRotate + 全量 metadata 剥离（EXIF/GPS/手机型号等）
 * 5. 重编码为安全输出格式（默认 WebP，带透明通道时保留 PNG）
 *
 * 公开与私有图片一律经过本管线，存储侧不再保留任何原始字节。
 */

export const MAX_IMAGE_DIMENSION = 12000;
export const MAX_IMAGE_PIXELS = 40_000_000; // 40MP，覆盖 12000x12000 上限内的合理总量

/** 重编码输出体积硬上限（纵深防御；正常输入远达不到） */
const MAX_OUTPUT_BYTES = 48 * 1024 * 1024;

const WEBP_QUALITY = 85;

export type ProcessedImage = {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  format: "webp" | "png";
};

export type ImageValidationErrorCode =
  | "INVALID_MAGIC_BYTES"
  | "UNSUPPORTED_IMAGE_TYPE"
  | "IMAGE_DECODE_FAILED"
  | "PIXEL_LIMIT_EXCEEDED"
  | "OUTPUT_TOO_LARGE";

export class ImageValidationError extends Error {
  readonly code: ImageValidationErrorCode;

  constructor(code: ImageValidationErrorCode, message: string) {
    super(message);
    this.name = "ImageValidationError";
    this.code = code;
  }
}

const MAGIC_BYTE_FORMATS = ["jpeg", "png", "webp"] as const;
export type MagicByteFormat = (typeof MAGIC_BYTE_FORMATS)[number];

/** sharp 超出输入像素上限时的错误信息特征 */
function isSharpPixelLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("pixel limit");
}

/** 文件头校验：仅认可 JPEG / PNG / WebP 三种真实文件头 */
export function detectImageFormatByMagicBytes(bytes: Uint8Array): MagicByteFormat | null {
  if (bytes.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }

  // WebP: "RIFF" + 4 字节长度 + "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }

  return null;
}

/**
 * 处理并重编码上传图片。
 * 任何一步失败都以 ImageValidationError 抛出，调用方禁止存储原始字节。
 */
export async function processUploadedImage(bytes: Buffer): Promise<ProcessedImage> {
  const format = detectImageFormatByMagicBytes(bytes);
  if (!format) {
    throw new ImageValidationError(
      "INVALID_MAGIC_BYTES",
      "文件内容不是有效的图片，仅支持JPG、PNG和WebP",
    );
  }

  let image: Sharp;
  let metadata: Metadata;
  try {
    // limitInputPixels 作为 decode 阶段的兜底；权威判定是下面的宽高/总像素检查，
    // 超大图在解析头部时就会被 sharp 拦下，错误统一归入 PIXEL_LIMIT_EXCEEDED
    image = sharp(bytes, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS });
    metadata = await image.metadata();
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    if (isSharpPixelLimitError(error)) {
      throw new ImageValidationError(
        "PIXEL_LIMIT_EXCEEDED",
        `图片尺寸超出限制（最长边 ${MAX_IMAGE_DIMENSION}px，总像素 ${MAX_IMAGE_PIXELS / 1_000_000}MP）`,
      );
    }
    throw new ImageValidationError(
      "IMAGE_DECODE_FAILED",
      "图片解析失败，文件可能已损坏",
    );
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new ImageValidationError(
      "PIXEL_LIMIT_EXCEEDED",
      `图片尺寸超出限制（最长边 ${MAX_IMAGE_DIMENSION}px，总像素 ${MAX_IMAGE_PIXELS / 1_000_000}MP）`,
    );
  }

  if (metadata.format && !MAGIC_BYTE_FORMATS.includes(metadata.format as MagicByteFormat)) {
    throw new ImageValidationError("UNSUPPORTED_IMAGE_TYPE", "不支持的图片格式");
  }

  const hasAlpha = metadata.hasAlpha === true;

  try {
    // .rotate() 无参 = 按 EXIF 方向自动摆正；重编码默认丢弃全部 metadata
    // （EXIF / GPS / XMP / 相机信息），仅保留像素数据。
    const pipeline = image.rotate();
    const output = hasAlpha
      ? await pipeline.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true })
      : await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer({ resolveWithObject: true });

    if (output.data.byteLength > MAX_OUTPUT_BYTES) {
      throw new ImageValidationError("OUTPUT_TOO_LARGE", "图片处理后体积超出限制");
    }

    return {
      buffer: output.data,
      mimeType: output.info.format === "png" ? "image/png" : "image/webp",
      width: output.info.width,
      height: output.info.height,
      format: output.info.format === "png" ? "png" : "webp",
    };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError(
      "IMAGE_DECODE_FAILED",
      "图片解码或重编码失败，文件可能已损坏",
    );
  }
}
