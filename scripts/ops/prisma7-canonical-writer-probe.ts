// R3D02A: executes production canonical functions, NOT a rewritten writer.
import { PrismaClient } from "../generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { softDeleteExtension } from "../r3c/prisma-soft-delete.ts";
import { domainEventLedgerExtension } from "../r3c/domain-event-ledger-extension.ts";
import { recordDomainEventTx } from "./lib/domain-events/domain-event.ts";
import { recordOutboxEventTx } from "./lib/async/outbox.ts";
import {
 LIQUIDITY_TRANSACTION_COMPLETED_EVENT_TYPE,
 LIQUIDITY_TRANSACTION_COMPLETED_EVENT_AGGREGATE_TYPE
} from "./lib/domain-events/domain-event-registry.ts";
import { PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE } from "./lib/async/outbox-event-registry.ts";

function assert(value:unknown, code:string):asserts value{
 if(!value)throw Error("R3D02A_"+code);
}
const url=process.env.DATABASE_URL!;
assert(new URL(url).pathname==="/"+process.env.EXPECTED_SHADOW_DB,
 "NON_SHADOW_DB");
const base=new PrismaClient({adapter:new PrismaPg({
 connectionString:url,max:5,connectionTimeoutMillis:2500
})});
const prisma=base.$extends(softDeleteExtension).$extends(domainEventLedgerExtension);
const buyer="r3d01-buyer", seller="r3d01-seller",
 product="r3d01-product", campus="r3d01-campus-a";
const completed="r3d02a-completed-order",
 expired="r3d02a-expired-order", aborted="r3d02a-aborted-order";
const at=new Date("2026-01-02T03:04:05Z");
const domainIntent=(orderId:string,tenant=campus)=>({
 eventType:LIQUIDITY_TRANSACTION_COMPLETED_EVENT_TYPE,
 schemaVersion:1,
 aggregateType:LIQUIDITY_TRANSACTION_COMPLETED_EVENT_AGGREGATE_TYPE,
 aggregateId:orderId,campusId:tenant,
 payload:{transactionId:orderId,transactionType:"PRODUCT"},
 occurredAt:at
});
const outboxIntent=(orderId:string)=>({
 eventType:PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
 schemaVersion:1,
 aggregateType:"ORDER",aggregateId:orderId,
 dedupeKey:"PRODUCT_RESERVATION_EXPIRED:"+orderId,
 payload:{orderId}
});
const mustReject=async(cb:()=>Promise<unknown>,code:string)=>{
 let matching=false;
 try{await cb();}catch(e){
   matching=e instanceof Error && (e as Error&{code?:string}).code===code;
 }
 assert(matching,"EXPECTED_ERROR_"+code);
};
try{
 await base.$connect();
 for(const [orderId,status] of [
   [completed,"COMPLETED"],[expired,"PENDING"],[aborted,"PENDING"]
 ] as const){
   await base.order.create({data:{
     id:orderId,orderNo:orderId,type:"PRODUCT",status,
     amount:"9.00",buyerId:buyer,sellerId:seller,productId:product,
     productReservationExpiresAt:new Date(Date.now()+3600000)
   }});
 }
 const initial=await prisma.$transaction(tx=>recordDomainEventTx(tx,domainIntent(completed)));
 assert(initial.recorded && initial.occurrenceKey===
   "LIQUIDITY_TRANSACTION_COMPLETED:PRODUCT:"+completed,"CANONICAL_OCCURRENCE");
 const reissued=await prisma.$transaction(tx=>recordDomainEventTx(tx,domainIntent(completed)));
 assert(!reissued.recorded && reissued.occurrenceKey===initial.occurrenceKey,
   "RETRY_NOT_IDEMPOTENT");
 const event=await base.domainEvent.findUniqueOrThrow({
   where:{occurrenceKey:initial.occurrenceKey}
 });
 const proj=await base.asyncJob.findMany({where:{
   kind:"ANALYTICS_PROJECT_DOMAIN_EVENT",
   dedupeKey:{contains:event.id}
 }});
 assert(proj.length===1 && (proj[0]?.payload as {eventId?:string})?.eventId===event.id,
   "PROJECTION_INTENT_NOT_CANONICAL");
 await mustReject(()=>prisma.$transaction(tx=>
   recordDomainEventTx(tx,domainIntent(completed,"r3d01-campus-b"))
 ),"DOMAIN_EVENT_OCCURRENCE_CONFLICT");
 assert(await base.domainEvent.count({where:{
   occurrenceKey:initial.occurrenceKey
 }})===1,"OCCURRENCE_COLLISION_CHANGED");
 console.log("[worker-cycle] PASS R3D02A canonical domain event with projection job and collision fence");

 await mustReject(()=>prisma.$transaction(tx=>recordDomainEventTx(tx,{
   ...domainIntent(aborted),
   payload:{transactionId:aborted,transactionType:"PRODUCT",untrusted:"free text"}
 })),"DOMAIN_EVENT_INTENT_CONTRACT_INVALID");
 await mustReject(()=>prisma.$transaction(tx=>recordOutboxEventTx(tx,{
   ...outboxIntent(expired),
   payload:{orderId:expired,untrusted:"free text"}
 })),"OUTBOX_EVENT_INTENT_CONTRACT_INVALID");
 assert(await base.domainEvent.count({where:{aggregateId:aborted}})===0 &&
   await base.outboxEvent.count({where:{aggregateId:expired}})===0,
   "REJECTED_INTENT_STORED");
 console.log("[worker-cycle] PASS R3D02A strict domain/outbox registry rejects malformed intents");

 const committed=await prisma.$transaction(async tx=>{
   const moved=await tx.order.updateMany({
     where:{id:expired,status:"PENDING",buyerId:buyer,sellerId:seller},
     data:{status:"CANCELLED",productReservationResolution:"EXPIRED",
       productReservationResolvedAt:new Date()}
   });
   assert(moved.count===1,"EXPIRED_CAS");
   return recordOutboxEventTx(tx,outboxIntent(expired));
 });
 assert(committed.recorded,"CANONICAL_OUTBOX_ABSENT");
 const again=await prisma.$transaction(tx=>recordOutboxEventTx(tx,outboxIntent(expired)));
 assert(!again.recorded,"OUTBOX_DUPLICATE_EFFECT");
 assert((await base.order.findUniqueOrThrow({where:{id:expired}})).status===
   "CANCELLED","ORDER_OUTBOX_DIVERGENCE");
 assert(await base.outboxEvent.count({where:{aggregateId:expired}})===1,
   "OUTBOX_UNIQUE_NOT_ENFORCED");
 console.log("[worker-cycle] PASS R3D02A canonical outbox atomic reservation expiry and replay dedupe");

 const jobsBefore=await base.asyncJob.count({where:{
   kind:"ANALYTICS_PROJECT_DOMAIN_EVENT"
 }});
 let abortedAsExpected=false;
 try{
   await prisma.$transaction(async tx=>{
     const moved=await tx.order.updateMany({
       where:{id:aborted,status:"PENDING"},
       data:{status:"COMPLETED"}
     });
     assert(moved.count===1,"ROLLBACK_PRECONDITION");
     await recordDomainEventTx(tx,domainIntent(aborted));
     await recordOutboxEventTx(tx,outboxIntent(aborted));
     throw Error("R3D02A_ABORT_AFTER_ALL_WRITES");
   });
 }catch(e){
   abortedAsExpected=e instanceof Error&&
     e.message==="R3D02A_ABORT_AFTER_ALL_WRITES";
 }
 assert(abortedAsExpected,"ROLLBACK_EXCEPTION_MISMATCH");
 assert((await base.order.findUniqueOrThrow({where:{id:aborted}})).status==="PENDING",
   "ROLLBACK_ORDER_MUTATED");
 assert(await base.domainEvent.count({where:{aggregateId:aborted}})===0,
   "ROLLBACK_DOMAIN_EVENT_MUTATED");
 assert(await base.outboxEvent.count({where:{aggregateId:aborted}})===0,
   "ROLLBACK_OUTBOX_MUTATED");
 assert(await base.asyncJob.count({where:{
   kind:"ANALYTICS_PROJECT_DOMAIN_EVENT"
 }})===jobsBefore,"ROLLBACK_ASYNCJOB_MUTATED");
 console.log("[worker-cycle] PASS R3D02A multi-writer Order/DomainEvent/Outbox/AsyncJob rollback");
}finally{await base.$disconnect();}
