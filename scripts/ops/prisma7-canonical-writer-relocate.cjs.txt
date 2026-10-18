// R3D02A: relocate ONLY module import strings in immutable source copies.
// Fail if a dependency is omitted: no test-only reimplementation of writers.
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(process.argv[2]);
const files=[
 "domain-events/domain-event.ts",
 "domain-events/domain-event-registry.ts",
 "domain-events/domain-event-ledger-extension.ts",
 "async/outbox.ts","async/outbox-event-registry.ts",
 "async/job-repository.ts","async/job-types.ts",
 "async/backoff.ts","analytics/projection-contract.ts"
];
for(const name of files){
 const target=path.resolve(root,name);
 const original=fs.readFileSync(target,"utf8");
 const rewrites=[];
 const relocated=original.replace(/(["'])@\/lib\/([a-z0-9/-]+)\1/g, (whole,q,mod)=>{
   const dest=path.resolve(root,mod+".ts");
   if(!fs.existsSync(dest))throw Error("R3D02A_UNMAPPED_PRODUCTION_DEPENDENCY");
   let rel=path.relative(path.dirname(target),dest).replaceAll(path.sep,"/");
   if(!rel.startsWith("."))rel="./"+rel;
   const to=q+rel+q;
   rewrites.push({from:whole,to});
   return to;
 }).replace(/import \{ Prisma \} from "@prisma\/client";/g, (whole)=>{
   let rel=path.relative(path.dirname(target),
     path.resolve(root,"../../generated/prisma/client.ts")).replaceAll(path.sep,"/");
   if(!rel.startsWith("."))rel="./"+rel;
   const to='import { Prisma } from "'+rel+'";';
   rewrites.push({from:whole,to});
   return to;
 });
 if(/["']@\/lib\//.test(relocated))throw Error("R3D02A_UNRELOCATED_ALIAS");
 let restored=relocated;
 for(const change of rewrites.slice().reverse()){
   const pieces=restored.split(change.to);
   if(pieces.length!==2)throw Error("R3D02A_RELOCATION_AMBIGUOUS");
   restored=pieces.join(change.from);
 }
 if(restored!==original)throw Error("R3D02A_NON_IMPORT_SOURCE_MUTATION");
 fs.writeFileSync(target,relocated);
}
console.log("[worker-cycle] PASS R3D02A original writer modules copied and imports mapped");
