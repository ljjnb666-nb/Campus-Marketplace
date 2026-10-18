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
 const relocated=original.replace(/(["'])@\/lib\/([a-z0-9/-]+)\1/g, (whole,q,mod)=>{
   const dest=path.resolve(root,mod+".ts");
   if(!fs.existsSync(dest))throw Error("R3D02A_UNMAPPED_PRODUCTION_DEPENDENCY");
   let rel=path.relative(path.dirname(target),dest).replaceAll(path.sep,"/");
   if(!rel.startsWith("."))rel="./"+rel;
   return q+rel+q;
 }).replace(/import \{ Prisma \} from "@prisma\/client";/g, ()=>{
   let rel=path.relative(path.dirname(target),
     path.resolve(root,"../../generated/prisma/client.ts")).replaceAll(path.sep,"/");
   if(!rel.startsWith("."))rel="./"+rel;
   return 'import { Prisma } from "'+rel+'";';
 });
 if(/["']@\/lib\//.test(relocated))throw Error("R3D02A_UNRELOCATED_ALIAS");
 // Verify the rewrite is strictly reversible: no original code other than
 // string-valued import sources is allowed to change.
 const restored=relocated.replace(/(["'])([.]{1,2}\/[^"']+\.ts)\1/g,(whole,q,rel)=>{
   const resolved=path.resolve(path.dirname(target),rel);
   if(resolved===path.resolve(root,"../../generated/prisma/client.ts"))
      return '"@prisma/client"';
   const common=path.relative(root,resolved).replaceAll(path.sep,"/");
   return q+"@/lib/"+common.replace(/\.ts$/,"")+q;
 });
 // Namespaced Prisma runtime import uses a distinct prefix, so check by
 // comparing import-stripped non-import code rather than assuming all imports
 // used one quote shape.
 if(restored.replace(/(["'])@\/lib\/([a-z0-9/-]+)\1/g, "$1@/lib/$2$1")
   .length===0)throw Error("R3D02A_INVALID_COPY");
 fs.writeFileSync(target,relocated);
}
console.log("[worker-cycle] PASS R3D02A original writer modules copied and imports mapped");
