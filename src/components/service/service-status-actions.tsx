import { updateServiceStatus } from "@/actions/service";
import { SERVICE_STATUS_LABELS } from "@/constants/service";

const statusOptions = [
  { value: "ACTIVE", label: "恢复接单" },
  { value: "PAUSED", label: "暂停接单" },
  { value: "OFFLINE", label: "下架服务" },
] as const;

export function ServiceStatusActions({
  serviceId,
  currentStatus,
}: {
  serviceId: string;
  currentStatus: keyof typeof SERVICE_STATUS_LABELS;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {statusOptions
        .filter((option) => option.value !== currentStatus)
        .map((option) => (
          <form key={option.value} action={updateServiceStatus}>
            <input type="hidden" name="serviceId" value={serviceId} />
            <input type="hidden" name="status" value={option.value} />
            <button
              type="submit"
              className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              {option.label}
            </button>
          </form>
        ))}
    </div>
  );
}
