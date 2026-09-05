export const USER_ROLE_LABELS = {
  STUDENT: "学生",
  ADMIN: "管理员",
} as const;

export const VERIFICATION_STATUS_LABELS = {
  UNVERIFIED: "未认证",
  PENDING: "审核中",
  VERIFIED: "已认证",
  REJECTED: "未通过",
  REVOKED: "已吊销",
} as const;
