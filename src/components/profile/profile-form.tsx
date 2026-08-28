"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useFormStatus } from "react-dom";
import type { UserActionState } from "@/actions/user";
import { ImageUploader, type UploadedImage } from "@/components/shared/image-uploader";

type ProfileFormValues = {
  name: string;
  bio?: string | null;
  college?: string | null;
  grade?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
};

function SubmitButton({ uploading }: { uploading: boolean }) {
  const { pending } = useFormStatus();
  const isDisabled = pending || uploading;

  return (
    <button
      type="submit"
      disabled={isDisabled}
      className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
    >
      {isDisabled ? "保存中..." : "保存资料"}
    </button>
  );
}

export function ProfileForm({
  action,
  initialValues,
}: {
  action: (
    state: UserActionState,
    formData: FormData,
  ) => Promise<UserActionState>;
  initialValues: ProfileFormValues;
}) {
  const router = useRouter();
  const { update } = useSession();
  const [images, setImages] = useState<UploadedImage[]>(
    initialValues.avatarUrl ? [{ url: initialValues.avatarUrl, preview: initialValues.avatarUrl }] : []
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setUploading(true);

    try {
      const formData = new FormData(e.currentTarget);

      if (images.length > 0) {
        const image = images[0];
        if (image.url) {
          formData.set("avatarUrl", image.url);
        } else if (image.file) {
          const uploadFormData = new FormData();
          uploadFormData.append("file", image.file);
          uploadFormData.append("category", "avatar");

          const response = await fetch("/api/upload/images", {
            method: "POST",
            body: uploadFormData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "上传失败");
          }

          const result = await response.json();
          formData.set("avatarUrl", result.url ?? `asset:${result.assetId}`);
        }
      } else {
        formData.set("avatarUrl", "");
      }

      const result = await action({ success: false, message: "" }, formData);

      if (result.success && result.data) {
        await update({
          name: result.data.name,
          image: result.data.avatarUrl,
        });

        router.refresh();

        if (result.redirectTo) {
          router.push(result.redirectTo);
        }
      } else if (result.message) {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          昵称
          <input
            name="name"
            defaultValue={initialValues.name}
            required
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
        <div className="flex flex-col gap-2 text-sm">
          <span>头像</span>
          <ImageUploader
            images={images}
            onChange={setImages}
            category="avatar"
          />
        </div>
      </div>

      <label className="flex flex-col gap-2 text-sm">
        个人简介
        <textarea
          name="bio"
          defaultValue={initialValues.bio ?? ""}
          rows={4}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          placeholder="介绍一下你的专业、兴趣或可提供的服务方向。"
        />
      </label>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="flex flex-col gap-2 text-sm">
          学院
          <input
            name="college"
            defaultValue={initialValues.college ?? ""}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          年级
          <input
            name="grade"
            defaultValue={initialValues.grade ?? ""}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          手机号
          <input
            name="phone"
            defaultValue={initialValues.phone ?? ""}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
          />
        </label>
      </div>

      {error && (
        <p className="text-sm text-rose-600">{error}</p>
      )}

      <div className="flex justify-end">
        <SubmitButton uploading={uploading} />
      </div>
    </form>
  );
}
