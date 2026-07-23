import React from "react";

export type RentalListingStatus =
  | "AVAILABLE"
  | "PAUSED"
  | "FULLY_BOOKED"
  | "OFFLINE"
  | "PENDING_REVIEW"
  | "BANNED";

export type RentalOrderStatus =
  | "PENDING_APPROVAL"
  | "PENDING_PAYMENT"
  | "PENDING_PICKUP"
  | "PICKED_UP"
  | "IN_RENTAL"
  | "PENDING_RETURN"
  | "PENDING_INSPECTION"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "OVERDUE"
  | "IN_DISPUTE"
  | "CLOSED";

export function RentalListingStatusBadge({ status }: { status: RentalListingStatus }) {
  const mapping: Record<RentalListingStatus, { label: string; className: string }> = {
    AVAILABLE: { label: "可租用", className: "bg-green-100 text-green-800" },
    PAUSED: { label: "已暂停", className: "bg-yellow-100 text-yellow-800" },
    FULLY_BOOKED: { label: "已满租", className: "bg-orange-100 text-orange-800" },
    OFFLINE: { label: "已下架", className: "bg-slate-100 text-slate-600" },
    PENDING_REVIEW: { label: "审核中", className: "bg-blue-100 text-blue-800" },
    BANNED: { label: "已封禁", className: "bg-red-100 text-red-800" },
  };

  const { label, className } = mapping[status] || { label: status, className: "bg-slate-100 text-slate-600" };

  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

export function RentalOrderStatusBadge({ status }: { status: RentalOrderStatus }) {
  const mapping: Record<RentalOrderStatus, { label: string; className: string }> = {
    PENDING_APPROVAL: { label: "待审批", className: "bg-yellow-100 text-yellow-800" },
    PENDING_PAYMENT: { label: "待支付", className: "bg-orange-100 text-orange-800" },
    PENDING_PICKUP: { label: "待交接", className: "bg-blue-100 text-blue-800" },
    PICKED_UP: { label: "已交接", className: "bg-cyan-100 text-cyan-800" },
    IN_RENTAL: { label: "租用中", className: "bg-indigo-100 text-indigo-800" },
    PENDING_RETURN: { label: "待归还", className: "bg-purple-100 text-purple-800" },
    PENDING_INSPECTION: { label: "待验货", className: "bg-violet-100 text-violet-800" },
    COMPLETED: { label: "已完成", className: "bg-green-100 text-green-800" },
    REJECTED: { label: "已拒绝", className: "bg-red-100 text-red-800" },
    CANCELLED: { label: "已取消", className: "bg-slate-100 text-slate-600" },
    OVERDUE: { label: "已逾期", className: "bg-red-100 text-red-800" },
    IN_DISPUTE: { label: "纠纷中", className: "bg-rose-100 text-rose-800" },
    CLOSED: { label: "已关闭", className: "bg-slate-100 text-slate-500" },
  };

  const { label, className } = mapping[status] || { label: status, className: "bg-slate-100 text-slate-600" };

  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}
