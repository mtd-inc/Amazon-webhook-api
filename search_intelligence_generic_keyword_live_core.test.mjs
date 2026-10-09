import {test} from "node:test";
import assert from "node:assert/strict";
import {TARGET,hash,buildPatch,assertApproval,fromVerifiedGate,executeLive} from "./search_intelligence_generic_keyword_live_core.mjs";
const listing={summaries:[{asin:TARGET.asin,productType:"NOTEBOOK_COMPUTER"}],attributes:{generic_keyword:[{value:TARGET.current,language_tag:"ja_JP",marketplace_id:"A1VC38T7YXB528"}]}};
const input={candidateId:TARGET.candidateId,sku:TARGET.sku,asin:TARGET.asin,field:TARGET.field,currentHash:TARGET.currentHash,proposedHash:TARGET.proposedHash,approvedAt:"2026-10-08T07:00:00Z",expiresAt:"2026-10-08T07:15:00Z",approvalId:"test",liveApprovalId:"live-test",approvalProof:"signed"};
test("scope: exactly one generic_keyword patch",()=>{const p=buildPatch(listing);assert.equal(p.path,"/attributes/generic_keyword");assert.equal(p.value[0].value,TARGET.proposed)});
test("hashes exact",()=>{assert.equal(hash(TARGET.current),TARGET.currentHash);assert.equal(hash(TARGET.proposed),TARGET.proposedHash)});
test("source drift blocked",()=>assert.throws(()=>buildPatch({...listing,attributes:{generic_keyword:[{value:"wrong"}]}}),/SOURCE_DRIFT/));
test("asin drift blocked",()=>assert.throws(()=>buildPatch({...listing,summaries:[{asin:"WRONG",productType:"NOTEBOOK_COMPUTER"}]}),/IDENTITY_DRIFT/));
test("expired blocked",()=>assert.throws(()=>assertApproval(input,Date.parse("2026-10-08T07:20:00Z")) ,/APPROVAL_EXPIRED/));
test("missing receipt blocked",()=>assert.throws(()=>assertApproval({...input,approvedAt:undefined},Date.parse("2026-10-08T07:05:00Z")) ,/VERIFIED_APPROVAL_RECEIPT_REQUIRED/));
test("one attempt on valid preview",async()=>{let calls=0;const r=await executeLive({input,now:()=>Date.parse("2026-10-08T07:05:00Z"),verifyProof:async()=>true,reserve:async()=>true,read:async()=>listing,preview:async()=>({valid:true,errorCount:0,issueCount:0}),live:async p=>{calls++;assert.equal(p.length,1);return {status:"ACCEPTED"}}});assert.equal(calls,1);assert.equal(r.liveAttempted,true)});
test("validation fails closed",async()=>{let calls=0;await assert.rejects(()=>executeLive({input,now:()=>Date.parse("2026-10-08T07:05:00Z"),verifyProof:async()=>true,reserve:async()=>true,read:async()=>listing,preview:async()=>({valid:false}),live:async()=>{calls++}}),/PREVIEW_FAILED/);assert.equal(calls,0)});
test("duplicate reservation fails closed",async()=>{let calls=0;await assert.rejects(()=>executeLive({input,now:()=>Date.parse("2026-10-08T07:05:00Z"),verifyProof:async()=>true,reserve:async()=>false,read:async()=>listing,preview:async()=>({valid:true,errorCount:0,issueCount:0}),live:async()=>{calls++}}),/ALREADY_RESERVED/);assert.equal(calls,0)});
test("invalid approval blocks before preview",async()=>{let calls=0;await assert.rejects(()=>executeLive({input,now:()=>Date.parse("2026-10-08T07:05:00Z"),verifyProof:async()=>false,reserve:async()=>true,read:async()=>{calls++},preview:async()=>({})}),/APPROVAL_INVALID/);assert.equal(calls,0)});

test("network timeout after reservation does not retry LIVE",async()=>{
  let reservations=0, sends=0;
  await assert.rejects(()=>executeLive({
    input,now:()=>Date.parse("2026-10-08T07:05:00Z"),
    verifyProof:async()=>true,
    reserve:async()=>{reservations++;return true;},
    read:async()=>listing,
    preview:async()=>({valid:true,errorCount:0,issueCount:0}),
    live:async()=>{sends++;throw Error("SOCKET_TIMEOUT");}
  }),/SOCKET_TIMEOUT/);
  assert.equal(reservations,1);
  assert.equal(sends,1);
});
test("second attempt is rejected by persistent reservation even after new run",async()=>{
  const held=new Set();
  let sends=0;
  const deps={
    input,now:()=>Date.parse("2026-10-08T07:05:00Z"),
    verifyProof:async()=>true,
    reserve:async()=>{if(held.has("target"))return false;held.add("target");return true;},
    read:async()=>listing,
    preview:async()=>({valid:true,errorCount:0,issueCount:0}),
    live:async()=>{sends++;return {status:"ACCEPTED"};}
  };
  await executeLive(deps);
  await assert.rejects(()=>executeLive(deps),/ALREADY_RESERVED/);
  assert.equal(sends,1);
});

test("listing attribute drift after preview blocks reservation and PATCH",async()=>{
  let reads=0,reservations=0,sends=0;
  const altered=structuredClone(listing);
  altered.attributes.item_name=[{value:"new title added concurrently"}];
  await assert.rejects(()=>executeLive({
    input,now:()=>Date.parse("2026-10-08T07:05:00Z"),
    verifyProof:async()=>true,
    reserve:async()=>{reservations++;return true},
    read:async()=>++reads===1?listing:altered,
    preview:async()=>({valid:true,errorCount:0,issueCount:0}),
    live:async()=>{sends++;return {status:"ACCEPTED"}}
  }),/PREFLIGHT_LISTING_DRIFT/);
  assert.equal(reservations,0);assert.equal(sends,0);
});
test("changed generic_keyword after preview prevents PATCH",async()=>{
  let reads=0,sends=0,reservations=0;
  const altered=structuredClone(listing);
  altered.attributes.generic_keyword[0].value="concurrent edit";
  await assert.rejects(()=>executeLive({
    input,now:()=>Date.parse("2026-10-08T07:05:00Z"),
    verifyProof:async()=>true,
    reserve:async()=>{reservations++;return true},
    read:async()=>++reads===1?listing:altered,
    preview:async()=>({valid:true,errorCount:0,issueCount:0}),
    live:async()=>{sends++}
  }),/SOURCE_DRIFT/);
  assert.equal(reservations,0);assert.equal(sends,0);
});

test("Control Plane receipt is authoritative over forged client times",()=>{
  const now=Date.parse("2026-10-08T07:05:00Z");
  const request={...input,approvedAt:"2099-01-01T00:00:00Z",expiresAt:"2099-01-01T00:15:00Z"};
  const receipt={ok:true,operation:"VERIFY",approvalId:input.approvalId,
    liveApprovalId:input.liveApprovalId,approvedAt:"2026-10-08T07:00:00Z",
    expiresAt:"2026-10-08T07:15:00Z",proposalExpiresAt:"2026-10-08T07:15:00Z"};
  const resolved=fromVerifiedGate(request,receipt,now);
  assert.equal(resolved.approvedAt,receipt.approvedAt);
  assert.equal(resolved.expiresAt,receipt.expiresAt);
  assert.equal(Object.hasOwn(resolved,"approvalProof"),false);
});
test("mismatched LIVE decision from gate fails closed",()=>{
  const receipt={ok:true,operation:"VERIFY",approvalId:input.approvalId,
    liveApprovalId:"wrong",approvedAt:"2026-10-08T07:00:00Z",
    expiresAt:"2026-10-08T07:15:00Z",proposalExpiresAt:"2026-10-08T07:15:00Z"};
  assert.throws(()=>fromVerifiedGate(input,receipt,Date.parse("2026-10-08T07:05:00Z")),/CONTROL_PLANE_RECEIPT_INVALID/);
});
test("expired proposal approval is blocked even with valid LIVE decision",()=>{
  const receipt={ok:true,operation:"VERIFY",approvalId:input.approvalId,
    liveApprovalId:input.liveApprovalId,approvedAt:"2026-10-08T07:00:00Z",
    expiresAt:"2026-10-08T07:15:00Z",proposalExpiresAt:"2026-10-08T07:04:00Z"};
  assert.throws(()=>fromVerifiedGate(input,receipt,Date.parse("2026-10-08T07:05:00Z")),/PROPOSAL_APPROVAL_EXPIRED/);
});
