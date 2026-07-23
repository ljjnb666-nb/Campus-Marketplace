import { updateErrandStatus } from "@/actions/errand";

export function ErrandStatusActions({
  errandId,
  actions,
}: {
  errandId: string;
  actions: Array<{ status: string; label: string }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <form key={action.status} action={updateErrandStatus}>
          <input type="hidden" name="errandId" value={errandId} />
          <input type="hidden" name="status" value={action.status} />
          <button
            type="submit"
            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
          >
            {action.label}
          </button>
        </form>
      ))}
    </div>
  );
}
