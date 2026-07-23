"use client";

import { useState } from "react";
import { X, Upload } from "lucide-react";

export interface UploadedImage {
  url: string;
  file?: File;
  preview: string;
}

interface ImageUploaderProps {
  images: UploadedImage[];
  onChange: (images: UploadedImage[]) => void;
  category: "avatar" | "product" | "rental" | "service" | "verification" | "handover" | "return" | "report";
  maxCount?: number;
  maxSizeMB?: number;
  coverIndex?: number;
  onCoverChange?: (index: number) => void;
  className?: string;
}

const CATEGORY_LIMITS = {
  avatar: { maxCount: 1, maxSize: 5 },
  product: { maxCount: 9, maxSize: 10 },
  rental: { maxCount: 9, maxSize: 10 },
  service: { maxCount: 5, maxSize: 10 },
  verification: { maxCount: 2, maxSize: 5 },
  handover: { maxCount: 5, maxSize: 10 },
  return: { maxCount: 5, maxSize: 10 },
  report: { maxCount: 5, maxSize: 10 },
};

export function ImageUploader({
  images,
  onChange,
  category,
  maxCount,
  maxSizeMB,
  coverIndex,
  onCoverChange,
  className = "",
}: ImageUploaderProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>("");

  const limits = CATEGORY_LIMITS[category];
  const finalMaxCount = maxCount ?? limits.maxCount;
  const finalMaxSize = maxSizeMB ?? limits.maxSize;

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setError("");

    const remainingSlots = finalMaxCount - images.length;
    if (files.length > remainingSlots) {
      setError(`最多只能上传${finalMaxCount}张图片`);
      return;
    }

    const validFiles: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setError("只能上传图片文件");
        return;
      }

      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        setError("仅支持JPG、PNG和WebP格式");
        return;
      }

      if (file.size > finalMaxSize * 1024 * 1024) {
        setError(`图片大小不能超过${finalMaxSize}MB`);
        return;
      }

      validFiles.push(file);
    }

    setUploading(true);

    try {
      const newImages: UploadedImage[] = [];

      for (const file of validFiles) {
        const preview = URL.createObjectURL(file);
        newImages.push({
          url: "",
          file,
          preview,
        });
      }

      onChange([...images, ...newImages]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleRemove = (index: number) => {
    const newImages = images.filter((_, i) => i !== index);
    onChange(newImages);

    if (coverIndex !== undefined && onCoverChange) {
      if (index === coverIndex) {
        onCoverChange(0);
      } else if (index < coverIndex) {
        onCoverChange(coverIndex - 1);
      }
    }
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newImages = [...images];
    [newImages[index - 1], newImages[index]] = [newImages[index], newImages[index - 1]];
    onChange(newImages);

    if (coverIndex !== undefined && onCoverChange) {
      if (index === coverIndex) {
        onCoverChange(index - 1);
      } else if (index - 1 === coverIndex) {
        onCoverChange(index);
      }
    }
  };

  const handleMoveDown = (index: number) => {
    if (index === images.length - 1) return;
    const newImages = [...images];
    [newImages[index], newImages[index + 1]] = [newImages[index + 1], newImages[index]];
    onChange(newImages);

    if (coverIndex !== undefined && onCoverChange) {
      if (index === coverIndex) {
        onCoverChange(index + 1);
      } else if (index + 1 === coverIndex) {
        onCoverChange(index);
      }
    }
  };

  const handleSetCover = (index: number) => {
    if (onCoverChange) {
      onCoverChange(index);
    }
  };

  const canUploadMore = images.length < finalMaxCount;

  return (
    <div className={className}>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {images.map((image, index) => (
          <div key={index} className="group relative aspect-square overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
            <img
              src={image.preview || image.url}
              alt={`预览 ${index + 1}`}
              className="h-full w-full object-cover"
            />

            {coverIndex !== undefined && onCoverChange && (
              <div className="absolute left-2 top-2">
                {index === coverIndex ? (
                  <span className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-semibold text-white shadow-md">
                    封面
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSetCover(index)}
                    className="rounded-lg bg-white/90 px-2 py-1 text-xs font-medium text-slate-700 shadow-md transition hover:bg-white"
                  >
                    设为封面
                  </button>
                )}
              </div>
            )}

            <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
              {index > 0 && (
                <button
                  type="button"
                  onClick={() => handleMoveUp(index)}
                  className="rounded-lg bg-white/90 p-1.5 text-slate-700 shadow-md transition hover:bg-white"
                  title="上移"
                >
                  ↑
                </button>
              )}
              {index < images.length - 1 && (
                <button
                  type="button"
                  onClick={() => handleMoveDown(index)}
                  className="rounded-lg bg-white/90 p-1.5 text-slate-700 shadow-md transition hover:bg-white"
                  title="下移"
                >
                  ↓
                </button>
              )}
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="rounded-lg bg-red-500/90 p-1.5 text-white shadow-md transition hover:bg-red-600"
                title="删除"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}

        {canUploadMore && (
          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 transition hover:border-indigo-400 hover:bg-indigo-50/50">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple={finalMaxCount > 1}
              onChange={handleFileSelect}
              disabled={uploading}
              className="hidden"
            />
            <Upload className={`h-8 w-8 ${uploading ? "text-slate-400" : "text-slate-400"}`} />
            <div className="text-center">
              <p className="text-sm font-medium text-slate-700">
                {uploading ? "上传中..." : "点击上传"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {images.length}/{finalMaxCount} · 最大{finalMaxSize}MB
              </p>
            </div>
          </label>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        支持JPG、PNG、WebP格式，单张图片不超过{finalMaxSize}MB，最多{finalMaxCount}张
      </p>
    </div>
  );
}
