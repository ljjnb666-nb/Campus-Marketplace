export type AssetServiceErrorCode =
  | "INVALID_CATEGORY" | "UNSUPPORTED_MIME" | "FILE_TOO_LARGE" | "TOO_MANY_FILES"
  | "UPLOAD_BATCH_TOO_LARGE" | "UPLOAD_RATE_LIMITED" | "UPLOAD_BUSY" | "ACCOUNT_INACTIVE"
  | "QUOTA_EXCEEDED" | "STORAGE_UPLOAD_FAILED" | "ASSET_RECORD_FAILED"
  | "INVALID_ASSET_REFERENCE" | "ASSET_CATEGORY_MISMATCH" | "ASSET_ALREADY_ATTACHED"
  | "ASSET_BIND_CONFLICT";

export class AssetServiceError extends Error {
  constructor(readonly code: AssetServiceErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = "AssetServiceError";
  }
}
