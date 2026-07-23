import React from "react";
import { StatusBadge, StatusBadgeVariant } from "@/components/ui/status-badge";

export interface UnifiedStatusMeta {
  label: string;
  hint: string;
  variant: StatusBadgeVariant;
}

export function getUnifiedStatusMeta(
  type: "PRODUCT" | "ERRAND" | "SERVICE" | "RENTAL",
  status: string,
  userRole?: "buyer" | "seller" | "publisher" | "accepter" | "renter" | "owner"
): UnifiedStatusMeta {
  // 1. 普通商品
  if (type === "PRODUCT") {
    switch (status) {
      case "PENDING":
        return {
          label: userRole === "seller" ? "待你确认售出" : "等待卖家确认",
          hint: userRole === "seller" ? "请及时确认是否同意售出给买家" : "卖家正在确认订单中",
          variant: "warning",
        };
      case "ACCEPTED":
        return {
          label: "交付履约中",
          hint: userRole === "buyer" ? "请与卖家在约定地点见面查验交接" : "请准备商品与买家见面交接",
          variant: "primary",
        };
      case "COMPLETED":
        return {
          label: "交易已完成",
          hint: "商品已完成交付结算",
          variant: "success",
        };
      case "CANCELLED":
        return {
          label: "订单已取消",
          hint: "交易已关闭取消",
          variant: "neutral",
        };
      default:
        return { label: status, hint: "", variant: "neutral" };
    }
  }

  // 2. 跑腿求助
  if (type === "ERRAND") {
    switch (status) {
      case "OPEN":
        return {
          label: "等待同学抢单",
          hint: "同校同学正在浏览抢单中",
          variant: "warning",
        };
      case "CLAIMED":
      case "IN_PROGRESS":
        return {
          label: "接单者履约中",
          hint: userRole === "accepter" ? "请按照约定取送位置尽快完成跑腿" : "接单同学正在跑腿送达中",
          variant: "primary",
        };
      case "PENDING_CONFIRMATION":
        return {
          label: userRole === "publisher" ? "待你确认完成" : "等待发布者验收",
          hint: userRole === "publisher" ? "接单同学已提交完成，请确认核对" : "已提交完成，等待发布者核对",
          variant: "warning",
        };
      case "COMPLETED":
        return {
          label: "跑腿已完成",
          hint: "赏金已发放结清",
          variant: "success",
        };
      case "CANCELLED":
        return {
          label: "任务已取消",
          hint: "跑腿任务已取消关闭",
          variant: "neutral",
        };
      default:
        return { label: status, hint: "", variant: "neutral" };
    }
  }

  // 3. 技能服务
  if (type === "SERVICE") {
    switch (status) {
      case "PENDING":
        return {
          label: userRole === "seller" ? "待你接单确认" : "等待服务者确认",
          hint: userRole === "seller" ? "有同学预约了你的技能服务，请及时接单" : "等待服务者核对预约时间",
          variant: "warning",
        };
      case "ACCEPTED":
      case "IN_PROGRESS":
        return {
          label: "服务履约中",
          hint: userRole === "seller" ? "请按约定时间地点提供专业服务" : "服务者正在履行预约服务",
          variant: "primary",
        };
      case "COMPLETED":
        return {
          label: "服务已完成",
          hint: "服务已被确认完成",
          variant: "success",
        };
      case "CANCELLED":
        return {
          label: "预约已取消",
          hint: "服务预约已取消",
          variant: "neutral",
        };
      default:
        return { label: status, hint: "", variant: "neutral" };
    }
  }

  // 4. 物品租赁 (RENTAL)
  switch (status) {
    case "PENDING_APPROVAL":
      return {
        label: userRole === "owner" ? "待你审核申请" : "等待出租者审核",
        hint: userRole === "owner" ? "有同学申请租用你的物品，请审核" : "等待出租者审核你的租赁申请",
        variant: "warning",
      };
    case "PENDING_PICKUP":
      return {
        label: "待当面交接取货",
        hint: "请在约定地点双方当面现场核对设备并确认取货",
        variant: "warning",
      };
    case "IN_RENTAL":
      return {
        label: "物品租赁使用中",
        hint: userRole === "renter" ? "请按约定妥善使用物品并按时归还" : "租客正在使用物品中",
        variant: "primary",
      };
    case "PENDING_RETURN":
      return {
        label: userRole === "owner" ? "待你验收归还" : "等待出租者验收",
        hint: userRole === "owner" ? "租客已提交归还，请当面查验设备状况" : "已提交归还，等待出租者现场验收",
        variant: "warning",
      };
    case "PENDING_INSPECTION":
      return {
        label: "损耗/定损处理中",
        hint: "正在沟通定损或扣除押金方案",
        variant: "danger",
      };
    case "COMPLETED":
      return {
        label: "租赁已归还结清",
        hint: "押金与租金已结算完毕",
        variant: "success",
      };
    case "CANCELLED":
    case "REJECTED":
    case "CLOSED":
      return {
        label: "租赁已关闭",
        hint: "租赁申请已终止或已取消",
        variant: "neutral",
      };
    case "OVERDUE":
      return {
        label: "租赁已逾期",
        hint: "租用时间已超过约定归还时刻",
        variant: "danger",
      };
    case "IN_DISPUTE":
      return {
        label: "申诉/纠纷处理中",
        hint: "双方已发起平台客服申诉调解",
        variant: "danger",
      };
    default:
      return { label: status, hint: "", variant: "neutral" };
  }
}

interface OrderStatusBadgeUnifiedProps {
  type: "PRODUCT" | "ERRAND" | "SERVICE" | "RENTAL";
  status: string;
  userRole?: "buyer" | "seller" | "publisher" | "accepter" | "renter" | "owner";
  showHint?: boolean;
  size?: "sm" | "md";
}

export function OrderStatusBadgeUnified({
  type,
  status,
  userRole,
  showHint = false,
  size = "md",
}: OrderStatusBadgeUnifiedProps) {
  const meta = getUnifiedStatusMeta(type, status, userRole);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <StatusBadge label={meta.label} variant={meta.variant} size={size} dot />
      {showHint && meta.hint && (
        <p className="text-[11px] text-slate-500 font-normal dark:text-slate-400">
          {meta.hint}
        </p>
      )}
    </div>
  );
}
