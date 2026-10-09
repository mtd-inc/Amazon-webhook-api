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
export function assertScope(input){
  if(input?.candidateId!==TARGET.candidateId||input.sku!==TARGET.sku||input.asin!==TARGET.asin||input.field!==TARGET.field) throw Error("TARGET_DRIFT");
  if(input.currentHash!==TARGET.currentHash||input.proposedHash!==TARGET.proposedHash||hash(TARGET.current)!==TARGET.currentHash||hash(TARGET.proposed)!==TARGET.proposedHash) throw Error("HASH_DRIFT");
  if(typeof input.approvalId!=="string"||!input.approvalId||
     typeof input.liveApprovalId!=="string"||!input.liveApprovalId) throw Error("APPROVAL_IDS_REQUIRED");
}
export function assertApproval(input,now=Date.now()){
  assertScope(input);
  if(typeof input.approvedAt!=="string"||typeof input.expiresAt!=="string") throw Error("VERIFIED_APPROVAL_RECEIPT_REQUIRED");
  const start=Date.parse(input.approvedAt),end=Date.parse(input.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||end-now<30000||end-start>910000||end<=start) throw Error("APPROVAL_EXPIRED");
}
export function fromVerifiedGate(input,receipt,now=Date.now()){
  assertScope(input);
  if(receipt?.ok!==true||receipt.operation!=="VERIFY"||
     receipt.approvalId!==input.approvalId||
     receipt.liveApprovalId!==input.liveApprovalId||
     typeof receipt.approvedAt!=="string"||
     typeof receipt.expiresAt!=="string"||
     typeof receipt.proposalExpiresAt!=="string") throw Error("CONTROL_PLANE_RECEIPT_INVALID");
  const result={candidateId:input.candidateId,sku:input.sku,asin:input.asin,
    field:input.field,currentHash:input.currentHash,proposedHash:input.proposedHash,
    approvalId:input.approvalId,liveApprovalId:input.liveApprovalId,
    approvedAt:receipt.approvedAt,expiresAt:receipt.expiresAt,
    proposalExpiresAt:receipt.proposalExpiresAt};
  assertApproval(result,now);
  const proposalEnd=Date.parse(receipt.proposalExpiresAt);
  if(!Number.isFinite(proposalEnd)||proposalEnd-now<30000) throw Error("PROPOSAL_APPROVAL_EXPIRED");
  return result;
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
  const initialListing=await read();
  const patch=buildPatch(initialListing);
  const validation=await preview([patch]);
  if(validation?.valid!==true||validation?.errorCount!==0||validation?.issueCount!==0) throw Error("PREVIEW_FAILED");
  // Re-read immediately before reserving a one-shot PATCH. A listing changed since
  // VALIDATION_PREVIEW is no longer the listing we validated: fail closed.
  const justBeforeReserve=await read();
  const freshPatch=buildPatch(justBeforeReserve);
  const originalAttributes=JSON.stringify(canonical(initialListing.attributes));
  const currentAttributes=JSON.stringify(canonical(justBeforeReserve.attributes));
  if(originalAttributes!==currentAttributes ||
     JSON.stringify(canonical(patch))!==JSON.stringify(canonical(freshPatch))) {
    throw Error("PREFLIGHT_LISTING_DRIFT");
  }
  assertApproval(input,now());
  if(!(await verifyProof(input))) throw Error("APPROVAL_INVALID");
  const reserved=await reserve(input.approvalId);
  if(!reserved) throw Error("ALREADY_RESERVED");
  // A failed/unknown response is NEVER retried.
  const result=await live([patch]);
  return {liveAttempted:true,liveResult:result,postVerifyRequired:true};
}

export function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function verifyPostListing(before,after){
  if(!after)return {verified:false,reason:"POST_GET_UNAVAILABLE"};
  if(!Array.isArray(after.summaries)||after.summaries.length!==1||
     after.summaries[0]?.asin!==TARGET.asin||
     after.summaries[0]?.productType!=="NOTEBOOK_COMPUTER")
    return {verified:false,reason:"POST_IDENTITY_DRIFT"};
  if(!after.attributes||typeof after.attributes!=="object"||
     !before.attributes||typeof before.attributes!=="object")
    return {verified:false,reason:"POST_ATTRIBUTES_MISSING"};
  const beforeOther={...before.attributes},afterOther={...after.attributes};
  delete beforeOther.generic_keyword;delete afterOther.generic_keyword;
  if(JSON.stringify(canonical(beforeOther))!==JSON.stringify(canonical(afterOther)))
    return {verified:false,reason:"POST_OTHER_ATTRIBUTES_DRIFT"};
  const entries=after.attributes.generic_keyword;
  if(!Array.isArray(entries)||entries.length!==1||
     typeof entries[0]?.value!=="string"||
     entries[0].value!==TARGET.proposed||
     hash(entries[0].value)!==TARGET.proposedHash)
    return {verified:false,reason:"POST_TARGET_NOT_REFLECTED"};
  const beforeEntries=before.attributes.generic_keyword;
  const originalMeta={...beforeEntries[0]},afterMeta={...entries[0]};
  delete originalMeta.value;delete afterMeta.value;
  if(JSON.stringify(canonical(originalMeta))!==JSON.stringify(canonical(afterMeta)))
    return {verified:false,reason:"POST_TARGET_METADATA_DRIFT"};
  return {verified:true,reason:"POST_VERIFIED"};
}
export function classifyLiveResult(response,post){
  const accepted=response?.httpStatus>=200&&response?.httpStatus<300&&
    response?.status==="ACCEPTED"&&response?.errorCount===0&&
    typeof response?.submissionId==="string"&&response.submissionId.length>0;
  if(post?.reason==="POST_OTHER_ATTRIBUTES_DRIFT"||post?.reason==="POST_IDENTITY_DRIFT"||
     post?.reason==="POST_TARGET_METADATA_DRIFT")
    return {ok:false,state:"POST_DRIFT",accepted,postVerified:false};
  if(post?.verified===true)
    return {ok:accepted,state:accepted?"POST_VERIFIED":"UNCERTAIN_VERIFIED_WITHOUT_ACCEPTANCE",accepted,postVerified:true};
  return {ok:false,state:accepted?"ACCEPTED_PENDING_VERIFY":"UNCERTAIN",accepted,postVerified:false};
}
