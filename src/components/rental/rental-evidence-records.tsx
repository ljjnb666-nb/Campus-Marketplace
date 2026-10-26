import type { RentalHandoverRecord, RentalReturnRecord } from "@prisma/client";
import { PrivateAssetViewer } from "@/components/shared/private-asset-viewer";

function Evidence({ title, photos, children }: {
  title: string; photos: string[]; children?: React.ReactNode;
}) {
  return <section className="space-y-2 rounded-xl border p-3 text-sm">
    <h3 className="font-semibold">{title}</h3>
    {children}
    <div className="flex flex-wrap gap-3">{photos.map((photo, index) =>
      <PrivateAssetViewer key={photo} value={photo} label={`照片 ${index + 1}`} />)}</div>
  </section>;
}

/** Only parties who passed the order-detail access check receive these records. */
export function RentalEvidenceRecords({ handover, returned }: {
  handover: RentalHandoverRecord | null; returned: RentalReturnRecord | null;
}) {
  const legacyPickupPhotos = handover?.photos.filter(photo =>
    ![...(handover.ownerPhotos ?? []), ...(handover.renterPhotos ?? [])].includes(photo)) ?? [];
  const legacyReturnPhotos = returned?.photos.filter(photo =>
    ![...(returned.ownerPhotos ?? []), ...(returned.renterPhotos ?? [])].includes(photo)) ?? [];
  const hasLegacyInspection = returned && typeof returned.legacyHasDamage === "boolean";
  return <div className="space-y-3">
    {handover?.ownerConfirmedAt && <Evidence title="取货：出租者提交" photos={handover.ownerPhotos}>
      <p>{handover.ownerCurrentCondition || "未填写现状说明"}</p><p>{handover.ownerKnownIssues || "未填写已知问题"}</p>
    </Evidence>}
    {handover?.renterConfirmedAt && <Evidence title="取货：租客提交" photos={handover.renterPhotos}>
      <p>{handover.renterCurrentCondition || "未填写现状说明"}</p><p>{handover.renterKnownIssues || "未填写已知问题"}</p>
    </Evidence>}
    {handover && (legacyPickupPhotos.length > 0 || handover.currentCondition || handover.knownIssues || handover.accessories) &&
      <Evidence title="历史交接记录（未区分提交者）" photos={legacyPickupPhotos}>
        <p>{handover.currentCondition}</p><p>{handover.knownIssues}</p><p>{handover.accessories}</p>
      </Evidence>}
    {returned?.ownerInspectionRecordedAt && <Evidence title="归还：出租者验收" photos={returned.ownerPhotos}>
      <p>{returned.hasDamage ? "有损坏" : "无损坏"} · {returned.needsCleaning ? "需清洁" : "无需清洁"} · {returned.accessoriesComplete ? "配件齐全" : "配件缺失"}</p>
      <p>{returned.inspectionNote}</p>
    </Evidence>}
    {returned?.renterConfirmedAt && typeof returned.renterHasDamage === "boolean" && <Evidence title="归还：租客陈述" photos={returned.renterPhotos}>
      <p>{returned.renterHasDamage ? "有损坏" : "无损坏"} · {returned.renterNeedsCleaning ? "需清洁" : "无需清洁"} · {returned.renterAccessoriesComplete ? "配件齐全" : "配件缺失"}</p>
      <p>{returned.renterInspectionNote}</p>
    </Evidence>}
    {returned && (legacyReturnPhotos.length > 0 || hasLegacyInspection) &&
      <Evidence title="历史归还记录（未区分提交者）" photos={legacyReturnPhotos}>
        {hasLegacyInspection && <>
          <p>{returned.legacyHasDamage ? "有损坏" : "无损坏"} · {returned.legacyNeedsCleaning ? "需清洁" : "无需清洁"} · {returned.legacyAccessoriesComplete ? "配件齐全" : "配件缺失"}</p>
          <p>{returned.legacyInspectionNote}</p>
        </>}
      </Evidence>}
  </div>;
}
