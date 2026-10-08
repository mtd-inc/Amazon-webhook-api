import crypto from "node:crypto";
export const TARGET = Object.freeze({
  candidateId:"CAND-7X-725F-2ZML-DYNABOOK-20260921",
  sku:"7X-725F-2ZML",asin:"B0HGDBYRS8",field:"generic_keyword",
  current:"ノートパソコン ノートPC 13.3型 FHD Windows 11 Pro モバイルPC",
  proposed:"ノートパソコン ノートPC 13.3型 FHD Windows 11 Pro モバイルPC dynabook",
  currentHash:"a34a0414c1b595ac0a1b92df37ed93574f93e2399e88f540074883189f5f91db",
  proposedHash:"2bae817231822104a63b1c4a13c3be354feba6d42c34faf4263d75f4fff885d6"
});
export const hash=v=>crypto.createHash("sha256").update(v,"utf8").digest("hex");
export function assertApproval(input,now=Date.now()){
  if(input?.candidateId!==TARGET.candidateId||input.sku!==TARGET.sku||input.asin!==TARGET.asin||input.field!==TARGET.field) throw Error("TARGET_DRIFT");
  if(input.currentHash!==TARGET.currentHash||input.proposedHash!==TARGET.proposedHash||hash(TARGET.current)!==TARGET.currentHash||hash(TARGET.proposed)!==TARGET.proposedHash) throw Error("HASH_DRIFT");
  if(!input.approvalId||!input.approvalProof||!input.approvedAt||!input.expiresAt) throw Error("APPROVAL_PROOF_REQUIRED");
  const start=Date.parse(input.approvedAt),end=Date.parse(input.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||end-now<30000||end-start>910000) throw Error("APPROVAL_EXPIRED");
}
export function buildPatch(listing){
  if(listing?.summaries?.[0]?.asin!==TARGET.asin||listing.summaries[0].productType!=="NOTEBOOK_COMPUTER") throw Error("IDENTITY_DRIFT");
  const rows=listing.attributes?.generic_keyword;
  if(!Array.isArray(rows)||rows.length!==1||typeof rows[0]?.value!=="string") throw Error("ATTRIBUTE_SHAPE");
  if(rows[0].value!==TARGET.current||hash(rows[0].value)!==TARGET.currentHash) throw Error("SOURCE_DRIFT");
  return {op:"replace",path:"/attributes/generic_keyword",value:[{...structuredClone(rows[0]),value:TARGET.proposed}]};
}
export async function executeLive({input,verifyProof,reserve,read,preview,live,now=()=>Date.now()}){
  assertApproval(input,now());
  if(!(await verifyProof(input))) throw Error("APPROVAL_INVALID");
  const patch=buildPatch(await read());
  const validation=await preview([patch]);
  if(validation?.valid!==true||validation?.errorCount!==0||validation?.issueCount!==0) throw Error("PREVIEW_FAILED");
  assertApproval(input,now());
  if(!(await verifyProof(input))) throw Error("APPROVAL_INVALID");
  const reserved=await reserve(input.approvalId);
  if(!reserved) throw Error("ALREADY_RESERVED");
  // A failed/unknown response is NEVER retried.
  const result=await live([patch]);
  return {liveAttempted:true,liveResult:result,postVerifyRequired:true};
}
