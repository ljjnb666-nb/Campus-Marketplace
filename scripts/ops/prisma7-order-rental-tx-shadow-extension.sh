#!/usr/bin/env bash
# Issue #157 R3D-01: real Prisma7-generated Client / original $extends,
# product Order + RentalOrder + DomainEvent + OutboxEvent on isolated shadow PG.
# This is a storage/transaction primitive proof, NOT an invocation of canonical
# product-order-lifecycle.ts / rental-order-machine.ts / event registry writer.
set -euo pipefail
[[ "$sha" =~ ^[a-f0-9]{40}$ && -n "$sandbox" && -n "$shadow_db" &&
   -n "$shadow_url" && -f "$sandbox/r3c/prisma-soft-delete.ts" ]] || {
  echo '[worker-cycle][FAIL] R3D01 lacks R3C shadow prerequisites' >&2; exit 1;
}
cat > "$sandbox/r3d01-probe.ts" <<'PROBE_R3D01'
import { PrismaClient } from "./generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { softDeleteExtension } from "./r3c/prisma-soft-delete.ts";
import { domainEventLedgerExtension } from "./r3c/domain-event-ledger-extension.ts";

function assert(ok: unknown, tag: string): asserts ok {
  if (!ok) throw new Error("R3D01_" + tag);
}
const db = process.env.EXPECTED_SHADOW_DB!;
const connectionString = process.env.DATABASE_URL!;
assert(new URL(connectionString).pathname === "/" + db, "UNSAFE_DATABASE");
const root = new PrismaClient({
  adapter: new PrismaPg({
    connectionString, max: 5, connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 10000
  }),
  log: ["error"]
});
const prisma = root.$extends(softDeleteExtension).$extends(domainEventLedgerExtension);
const scope = "r3d01";
const campusId = scope+"-campus-a";
const foreignCampus = scope+"-campus-b";
const seller = scope+"-seller";
const buyer = scope+"-buyer";
const outsider = scope+"-outsider";
const productId = scope+"-product";
const productOrderId = scope+"-product-order";
const rentalId = scope+"-rental-listing";
const rentalOrderId = scope+"-rental-order";
const abortOrderId = scope+"-aborted-order";
const now = new Date();
const orderEvent = (id: string, key: string, aggregateId: string) => ({
  id, eventType: "R3D01_STORAGE_PROOF", schemaVersion: 1,
  aggregateType: "ORDER", aggregateId, campusId, occurrenceKey: key,
  payload: { machine: "R3D01", version: 1 }, occurredAt: now
});
const outboxEvent = (key: string, aggregateId: string) => ({
  eventType: "R3D01_STORAGE_PROOF", schemaVersion: 1,
  aggregateType: "ORDER", aggregateId, dedupeKey: key,
  payload: { machine: "R3D01", version: 1 }, availableAt: now
});
const userData = (id: string, campusId: string) => ({
  id, name: id, email: id+"@example.invalid",
  passwordHash: "synthetic-not-a-login", campusId,
  schoolName: "isolated.example.invalid"
});
try {
  await root.$connect();
  for (const [id,slug] of [[campusId,"a"],[foreignCampus,"b"]] as const) {
    await root.campus.create({data:{
      id,name:"R3D01 "+slug,slug:"r3d01-"+slug,
      schoolName:"isolated.example.invalid"
    }});
  }
  await root.user.create({data:userData(seller,campusId)});
  await root.user.create({data:userData(buyer,campusId)});
  await root.user.create({data:userData(outsider,foreignCampus)});
  await root.productCategory.create({data:{
    id:scope+"-product-category",name:"R3D01 test",slug:"r3d01-product"
  }});
  await root.rentalCategory.create({data:{
    id:scope+"-rental-category",name:"R3D01 test",slug:"r3d01-rental"
  }});
  await root.product.create({data:{
    id:productId,title:"Synthetic",description:"Synthetic",
    price:"9.00",locationText:"isolated",condition:"NEW",
    status:"RESERVED",sellerId:seller,campusId,
    categoryId:scope+"-product-category"
  }});
  await root.rentalListing.create({data:{
    id:rentalId,ownerId:seller,campusId,
    categoryId:scope+"-rental-category",title:"Synthetic",
    description:"Synthetic",condition:"NEW",price:"4.00",
    pricingUnit:"PER_DAY",depositAmount:"0.00",
    minimumDuration:1,maximumDuration:7,
    pickupLocation:"isolated",returnLocation:"isolated"
  }});
  await root.order.create({data:{
    id:productOrderId,orderNo:"R3D01-PRODUCT",type:"PRODUCT",
    status:"PENDING",paymentStatus:"UNPAID",
    amount:"9.00",buyerId:buyer,sellerId:seller,productId,
    productReservationExpiresAt:new Date(Date.now()+3600_000)
  }});
  await root.rentalOrder.create({data:{
    id:rentalOrderId,orderNumber:"R3D01-RENTAL",
    rentalListingId:rentalId,ownerId:seller,renterId:buyer,
    startTime:new Date(Date.now()+86400_000),
    endTime:new Date(Date.now()+2*86400_000),
    unitPriceSnapshot:"4.00",pricingUnitSnapshot:"PER_DAY",
    rentalDuration:1,rentalAmount:"4.00",depositAmount:"0.00",
    finalAmount:"4.00",pickupLocationSnapshot:"isolated",
    returnLocationSnapshot:"isolated",
    status:"PENDING_APPROVAL"
  }});
  console.log("[worker-cycle] PASS R3D01 actual Product Order and RentalOrder shadow fixtures");

  // Cross-campus request is blocked ONLY because of an explicit scoped where;
  // nothing here claims the Prisma extension supplies RBAC automatically.
  const bad = await prisma.order.updateMany({
    where:{id:productOrderId,buyerId:outsider,status:"PENDING"},
    data:{status:"CANCELLED"}
  });
  assert(bad.count===0,"UNSCOPED_PRODUCT_MUTATION");
  const productTransition = (status:"ACCEPTED"|"CANCELLED") =>
    prisma.$transaction(async tx=>{
      const changed = await tx.order.updateMany({
        where:{id:productOrderId,status:"PENDING",type:"PRODUCT",
          buyerId:buyer,sellerId:seller},
        data:{status,productReservationResolution:status,
          productReservationResolvedAt:now}
      });
      if(changed.count===1) {
        await tx.outboxEvent.createMany({
          data:[outboxEvent("r3d01-product-one-fact",productOrderId)],
          skipDuplicates:true
        });
        await tx.domainEvent.createMany({
          data:[orderEvent("r3d01-event-product","r3d01-occ-product",productOrderId)],
          skipDuplicates:true
        });
      }
      return changed.count;
    },{timeout:8000,maxWait:4000});
  const productResults = await Promise.all([
    productTransition("ACCEPTED"),productTransition("CANCELLED")
  ]);
  assert(productResults.reduce((x,n)=>x+n,0)===1,
    "PRODUCT_DOUBLE_TRANSITION");
  const productRow=await root.order.findUniqueOrThrow({where:{id:productOrderId}});
  assert(productRow.status==="ACCEPTED"||productRow.status==="CANCELLED",
    "PRODUCT_FINAL_STATE");
  assert(productRow.productReservationResolution===productRow.status &&
    productRow.productReservationResolvedAt!==null,"PRODUCT_RESOLUTION_DRIFT");
  assert(await root.outboxEvent.count({
    where:{dedupeKey:"r3d01-product-one-fact"}
  })===1,"PRODUCT_OUTBOX_COUNT");
  assert(await root.domainEvent.count({
    where:{occurrenceKey:"r3d01-occ-product"}
  })===1,"PRODUCT_DOMAIN_COUNT");
  assert(await productTransition(productRow.status)===0,
    "PRODUCT_REPLAY_REENTERED");
  assert(await root.outboxEvent.count({
    where:{dedupeKey:"r3d01-product-one-fact"}
  })===1,"PRODUCT_REPLAY_DUPLICATED");
  console.log("[worker-cycle] PASS R3D01 Product Order CAS concurrency, atomic event/outbox and replay dedupe");

  const rentalTransition=(status:"PENDING_PICKUP"|"CANCELLED")=>
    prisma.$transaction(async tx=>{
      const changed=await tx.rentalOrder.updateMany({
        where:{id:rentalOrderId,status:"PENDING_APPROVAL",ownerId:seller,renterId:buyer},
        data:{status}
      });
      if(changed.count===1){
        await tx.rentalOrderStatusLog.create({
          data:{orderId:rentalOrderId,fromStatus:"PENDING_APPROVAL",
            toStatus:status,operatorId:seller,note:"R3D01 machine fact"}
        });
        await tx.domainEvent.createMany({
          data:[orderEvent("r3d01-event-rental","r3d01-occ-rental",rentalOrderId)],
          skipDuplicates:true
        });
        await tx.outboxEvent.createMany({
          data:[outboxEvent("r3d01-rental-one-fact",rentalOrderId)],
          skipDuplicates:true
        });
      }
      return changed.count;
    },{timeout:8000,maxWait:4000});
  const rentalResults=await Promise.all([
    rentalTransition("PENDING_PICKUP"),rentalTransition("CANCELLED")
  ]);
  assert(rentalResults.reduce((x,n)=>x+n,0)===1,"RENTAL_DOUBLE_TRANSITION");
  const rentalRow=await root.rentalOrder.findUniqueOrThrow({
    where:{id:rentalOrderId}
  });
  assert(rentalRow.status==="PENDING_PICKUP"||rentalRow.status==="CANCELLED",
    "RENTAL_FINAL_STATE");
  assert(await root.rentalOrderStatusLog.count({
    where:{orderId:rentalOrderId}
  })===1,"RENTAL_DUPLICATE_STATUS_LOG");
  const rentalLog=await root.rentalOrderStatusLog.findFirstOrThrow({
    where:{orderId:rentalOrderId}
  });
  assert(rentalLog.toStatus===rentalRow.status,"RENTAL_STATUS_LOG_DRIFT");
  assert(await root.domainEvent.count({
    where:{occurrenceKey:"r3d01-occ-rental"}
  })===1,"RENTAL_DOMAIN_FACT_DUP");
  assert(await root.outboxEvent.count({
    where:{dedupeKey:"r3d01-rental-one-fact"}
  })===1,"RENTAL_OUTBOX_DUP");
  assert(await rentalTransition(rentalRow.status)===0,"RENTAL_REPLAY_REENTERED");
  console.log("[worker-cycle] PASS R3D01 RentalOrder CAS concurrence and atomic status-log/event/outbox");

  // A multi-table transaction that fails after its Outbox write must leave
  // no order state transition, no ledger event and no outbox record.
  await root.order.create({data:{
    id:abortOrderId,orderNo:"R3D01-ABORT",type:"PRODUCT",
    status:"PENDING",amount:"9.00",buyerId:buyer,sellerId:seller,productId,
    productReservationExpiresAt:new Date(Date.now()+3600_000)
  }});
  let expectedAbort=false;
  try {
    await prisma.$transaction(async tx=>{
      const changed=await tx.order.updateMany({
        where:{id:abortOrderId,status:"PENDING"},
        data:{status:"ACCEPTED"}
      });
      assert(changed.count===1,"ABORT_SETUP_FAILED");
      await tx.outboxEvent.createMany({
        data:[outboxEvent("r3d01-abort-outbox",abortOrderId)],
        skipDuplicates:true
      });
      await tx.domainEvent.createMany({
        data:[orderEvent("r3d01-abort-event","r3d01-abort-occ",abortOrderId)],
        skipDuplicates:true
      });
      throw new Error("R3D01_EXPECTED_ROLLBACK");
    },{timeout:8000,maxWait:4000});
  }catch(e){
    expectedAbort=e instanceof Error && e.message==="R3D01_EXPECTED_ROLLBACK";
  }
  assert(expectedAbort,"ABORT_SIGNAL");
  assert((await root.order.findUniqueOrThrow({
    where:{id:abortOrderId}
  })).status==="PENDING","ORDER_ROLLBACK_LEAK");
  assert(await root.domainEvent.count({
    where:{occurrenceKey:"r3d01-abort-occ"}
  })===0,"DOMAIN_ROLLBACK_LEAK");
  assert(await root.outboxEvent.count({
    where:{dedupeKey:"r3d01-abort-outbox"}
  })===0,"OUTBOX_ROLLBACK_LEAK");
  console.log("[worker-cycle] PASS R3D01 multi-table Order/DomainEvent/Outbox rollback atomicity");

  // The DB UNIQUE constraints must keep semantic event identity across
  // repeated deliveries, including a concurrent duplicate delivery window.
  const insertOnce=()=>prisma.$transaction(async tx=>{
    const e=await tx.domainEvent.createMany({
      data:[orderEvent("r3d01-retry-event","r3d01-occ-retry",productOrderId)],
      skipDuplicates:true
    });
    const o=await tx.outboxEvent.createMany({
      data:[outboxEvent("r3d01-dedupe-retry",productOrderId)],
      skipDuplicates:true
    });
    return {event:e.count,outbox:o.count};
  },{timeout:8000,maxWait:4000});
  const repeated=await Promise.all([insertOnce(),insertOnce(),insertOnce()]);
  assert(repeated.reduce((acc,x)=>acc+x.event,0)===1 &&
    repeated.reduce((acc,x)=>acc+x.outbox,0)===1,
    "UNIQUE_DEDUPE_NOT_ATOMIC");
  assert(await root.domainEvent.count({where:{
    occurrenceKey:"r3d01-occ-retry"
  }})===1 && await root.outboxEvent.count({where:{
    dedupeKey:"r3d01-dedupe-retry"
  }})===1,"RETRY_DURABLE_COUNTS");
  console.log("[worker-cycle] PASS R3D01 real unique occurrence/outbox dedupe under concurrent replay");
}finally{
  await root.$disconnect();
}
PROBE_R3D01

if ! timeout --signal=TERM --kill-after=10s 120s docker run --rm \
  --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
  --workdir /shadow \
  -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3d01-probe.ts \
  >"$tmp/r3d01-probe.log" 2>&1; then
  echo '[worker-cycle][FAIL] R3D01 shadow Order/RentalOrder transaction primitive probe failed' >&2; exit 1;
fi
for marker in \
  'PASS R3D01 actual Product Order and RentalOrder shadow fixtures' \
  'PASS R3D01 Product Order CAS concurrency, atomic event/outbox and replay dedupe' \
  'PASS R3D01 RentalOrder CAS concurrence and atomic status-log/event/outbox' \
  'PASS R3D01 multi-table Order/DomainEvent/Outbox rollback atomicity' \
  'PASS R3D01 real unique occurrence/outbox dedupe under concurrent replay'; do
  grep -qF "$marker" "$tmp/r3d01-probe.log" || {
    echo '[worker-cycle][FAIL] R3D01 missing precise semantic proof marker' >&2; exit 1;
  }
done
echo '[worker-cycle] PASS R3D01 actual Order/RentalOrder rows CAS, atomically coordinated ledger/outbox and dedupe on Prisma7 shadow'
echo '[worker-cycle] LIMIT R3D01 tests database primitives; it does NOT import canonical product/rental lifecycle, domain writer or outbox registry, nor test auth/notification dispatch'
