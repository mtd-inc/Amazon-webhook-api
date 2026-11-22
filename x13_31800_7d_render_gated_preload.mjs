import fetch from "node-fetch";
import crypto from "node:crypto";
import { state as parseState, buildPreview } from "./x13_31800_7d_price_preview_preload.mjs";

/**
 * X13 8GB/256GB single-SKU 31,800 yen seven-day liquidation.
 * Render startup runner: disabled by default, PREVIEW and LIVE are separate
 * env-gated stages. It NEVER exposes an unauthenticated or new LIVE route.
 * A prospective LIVE Amazon PATCH is sent at most once per startup.
 * After completion disable the gate; after the one-time approval deadline all
 * invocations refuse LIVE even if a deployment restarts.
 */
const V="X13_31800_7D_RENDER_GATED_V1_20261122";
const SKU="NY-G14F-GH8Y";
const ASIN="B0FMS8XJ3D";
const MARKETPLACE="A1VC38T7YXB528";
const APPROVAL="X13_ONLY_NY_G14F_GH8Y_31800_7DAY_APPROVED_20261122";
const APPROVAL_DEADLINE="2026-11-22T15:00:00.000Z";
const EXPECTED={normal:34900,min:28800,b2b:59850,price:31800};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clone=x=>JSON.parse(JSON.stringify(x));
const event=(stage,fields={})=>console.log("X13_31800_PRICE_TEST "+JSON.stringify({v:V,stage,...fields}));
const money=x=>x===null||x===undefined?null:Number(x);
function settings(){
 const seller=String(process.env.SPAPI_SELLER_ID||"");
 const marketplace=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE);
 const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
 if(!seller||marketplace!==MARKETPLACE||!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint))throw Error("CONFIG_INVALID");
 if(!process.env.LWA_CLIENT_ID||!process.env.LWA_CLIENT_SECRET||!process.env.REFRESH_TOKEN)throw Error("LWA_CONFIG_MISSING");
 return {seller,marketplace,endpoint};
}
async function token(){
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),20000);
 try{
  const response=await fetch("https://api.amazon.com/auth/o2/token",{
   method:"POST",signal:ctrl.signal,
   headers:{"content-type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({grant_type:"refresh_token",client_id:process.env.LWA_CLIENT_ID,
     client_secret:process.env.LWA_CLIENT_SECRET,refresh_token:process.env.REFRESH_TOKEN})
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok||!body.access_token)throw Error("LWA_HTTP_"+response.status);
  return body.access_token;
 }finally{clearTimeout(timer)}
}
async function api(access,method,body=null,preview=false){
 const {seller,marketplace,endpoint}=settings();
 const q=new URLSearchParams({marketplaceIds:marketplace,issueLocale:"ja_JP"});
 if(method==="GET")q.set("includedData","summaries,attributes,issues,fulfillmentAvailability");
 if(preview)q.set("mode","VALIDATION_PREVIEW");
 const url=endpoint+"/listings/2021-08-01/items/"+encodeURIComponent(seller)+"/"+encodeURIComponent(SKU)+"?"+q.toString();
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),25000);
 try{
  const response=await fetch(url,{
   method, signal:ctrl.signal,
   headers:{"x-amz-access-token":access,accept:"application/json",...(body?{"content-type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{})
  });
  const out=await response.json().catch(()=>({}));
  if(!response.ok){const issues=Array.isArray(out.issues)?out.issues:[];const codes=issues.map(i=>String(i.code||"UNKNOWN").slice(0,20));const attrs=issues.map(i=>Array.isArray(i.attributeNames)?i.attributeNames.map(String).slice(0,3):[]);throw Error("SPAPI_"+method+"_"+(preview?"VALIDATION_":"")+"HTTP_"+response.status+"_ISSUES_"+JSON.stringify({codes,attrs,status:out.status||null}));}
  return {http:response.status,data:out};
 }finally{clearTimeout(timer)}
}
function fingerprintOf(listing){
 const offers=clone(listing.attributes?.purchasable_offer||[]);
 const consumer=offers.filter(x=>String(x?.audience?.value||x?.audience||"ALL").toUpperCase()==="ALL");
 if(consumer.length!==1)throw Error("NOT_EXACTLY_ONE_CONSUMER");
 delete consumer[0].discounted_price;
 return crypto.createHash("sha256").update(JSON.stringify(offers)).digest("hex");
}
function baseline(got){
 const p=parseState(got,Date.now()),plan=buildPreview(p,Date.now());
 const list=got.attributes?.purchasable_offer||[];
 const future=list.filter(x=>String(x?.audience?.value||x?.audience||"ALL").toUpperCase()==="ALL")
  .flatMap(x=>x.discounted_price||[]).flatMap(x=>x.schedule||[])
  .filter(x=>!x.start_at||Date.parse(x.start_at)>Date.now());
 const blocks=[...plan.blocks];
 if(future.length)blocks.push("FUTURE_SALE_EXISTS");
 if(!(EXPECTED.price>EXPECTED.min&&EXPECTED.price<EXPECTED.normal))blocks.push("PRICE_SCOPE_INVALID");
 return {p,plan,blocks,listingHash:fingerprintOf(got)};
}
function approved(){
 return process.env.X13_31800_STARTUP_APPROVAL===APPROVAL &&
  Date.now()<=Date.parse(APPROVAL_DEADLINE);
}
function patchOf(p){
 return {productType:p.productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:p.plan.offers}]};
}
async function checkAfter(access,before,plan){
 let last={};
 for(let attempt=0;attempt<8;attempt++){
  if(attempt)await sleep(1800);
  const got=(await api(access,"GET")).data;
  const s=parseState(got,Date.now());
  const c=(got.attributes?.purchasable_offer||[]).find(x=>String(x?.audience?.value||x?.audience||"ALL").toUpperCase()==="ALL");
  const periods=c?.discounted_price?.[0]?.schedule||[];
  const matching=periods.some(x=>money(x.value_with_tax)===EXPECTED.price &&
     Math.abs(Date.parse(x.start_at)-Date.parse(plan.start))<1000 &&
     Math.abs(Date.parse(x.end_at)-Date.parse(plan.end))<1000);
  last={attempt:attempt+1,sale:s.sale,normal:s.normal,min:s.min,b2b:s.b2b,
   buyable:s.statuses.includes("BUYABLE"),errors:s.errorCodes,quantity:s.qty,matching,
   preserved:fingerprintOf(got)===before.listingHash};
  if(matching&&last.normal===EXPECTED.normal&&last.min===EXPECTED.min&&
   last.b2b===EXPECTED.b2b&&last.buyable&&last.errors.length===0&&last.preserved)
    return {ok:true,...last};
 }
 return {ok:false,...last};
}
export async function run(mode=String(process.env.X13_31800_STARTUP_MODE||"DISABLED").toUpperCase()){
 if(mode!=="PREVIEW"&&mode!=="LIVE")return {status:"DISABLED"};
 if(mode==="LIVE"&&!approved()){event("LIVE_REFUSED_NO_CURRENT_APPROVAL");return {status:"REFUSED_APPROVAL"}}
 try{
  const access=await token();
  const original=(await api(access,"GET")).data;
  const current=parseState(original,Date.now());
  if(current.sale===EXPECTED.price){
   event("ALREADY_ON_SALE_NO_PATCH",{normal:current.normal,min:current.min,b2b:current.b2b,qty:current.qty});
   return {status:"ALREADY_ON_SALE_NO_PATCH"};
  }
  const before=baseline(original);
  if(before.blocks.length){
   event("PREFLIGHT_BLOCKED",{blocks:before.blocks,normal:before.p.normal,min:before.p.min,
     b2b:before.p.b2b,qty:before.p.qty,sale:before.p.sale,externalChanges:0});
   return {status:"BLOCKED",blocks:before.blocks};
  }
  const payload=patchOf(before);
  const validated=await api(access,"PATCH",payload,true);
  const issues=Array.isArray(validated.data.issues)?validated.data.issues:[];
  const errors=issues.filter(x=>String(x.severity).toUpperCase()==="ERROR");
  if(String(validated.data.status||"").toUpperCase()!=="VALID"||errors.length){
   const issueCodes=issues.map(x=>String(x.code||""));
   event("VALIDATION_BLOCKED",{http:validated.http,status:validated.data.status,
      issueCodes,externalChanges:0});
   return {status:"VALIDATION_BLOCKED",issueCodes};
  }
  const second=(await api(access,"GET")).data;
  const afterPreview=baseline(second);
  if(afterPreview.blocks.length||before.listingHash!==afterPreview.listingHash||
     !same(before.p.offers,afterPreview.p.offers)){
   event("POST_PREVIEW_DRIFT_BLOCKED",{blocks:afterPreview.blocks,externalChanges:0});
   return {status:"POST_PREVIEW_DRIFT_BLOCKED"};
  }
  if(mode==="PREVIEW"){
   event("VALIDATION_PREVIEW_PASS_NO_MUTATION",{http:validated.http,
    normal:before.p.normal,min:before.p.min,b2b:before.p.b2b,qty:before.p.qty,
    targetSale:EXPECTED.price,saleDays:7,externalChanges:0});
   return {status:"VALIDATION_PREVIEW_PASS_NO_MUTATION"};
  }
  if(!approved()){
   event("APPROVAL_EXPIRED_BEFORE_WRITE",{externalChanges:0});
   return {status:"EXPIRED_APPROVAL"};
  }
  // Exactly one LIVE PATCH. Do NOT retry on a timeout, transport error or ambiguous acceptance.
  event("LIVE_PATCH_SUBMITTING",{sku:SKU,asin:ASIN,targetSale:EXPECTED.price});
  let accepted;
  try{
   accepted=await api(access,"PATCH",payload,false);
  }catch(e){
   event("LIVE_RESULT_UNCERTAIN_DO_NOT_RETRY",{error:String(e.message),patchAttempts:1});
   return {status:"LIVE_RESULT_UNCERTAIN_DO_NOT_RETRY"};
  }
  const errs=(accepted.data.issues||[]).filter(x=>String(x.severity).toUpperCase()==="ERROR");
  const ok=String(accepted.data.status||"").toUpperCase()==="ACCEPTED"&&errs.length===0;
  if(!ok){
   event("LIVE_RESPONSE_NOT_ACCEPTED_DO_NOT_RETRY",{
    status:accepted.data.status,issueCodes:errs.map(x=>x.code),patchAttempts:1});
   return {status:"LIVE_RESPONSE_NOT_ACCEPTED_DO_NOT_RETRY"};
  }
  const verified=await checkAfter(access,before,before.plan);
  event(verified.ok?"LIVE_FRESH_VERIFIED_7D_STARTED":"LIVE_ACCEPTED_FRESH_INCOMPLETE_DO_NOT_RETRY",{
   ...verified,sku:SKU,asin:ASIN,targetSale:EXPECTED.price,
   scheduledEndAt:before.plan.end,externalChanges:1,
   freshVerifiedAt:verified.ok?new Date().toISOString():null});
  return {status:verified.ok?"LIVE_FRESH_VERIFIED_7D_STARTED":"LIVE_ACCEPTED_FRESH_INCOMPLETE_DO_NOT_RETRY",
   ...verified};
 }catch(e){
  event("FAILED_CLOSED",{error:String(e.message).slice(0,150),externalChanges:"unknown_if_after_live"});
  return {status:"FAILED_CLOSED",error:String(e.message).slice(0,150)};
 }
}
if(process.env.X13_31800_STARTUP_MODE==="PREVIEW"||
   process.env.X13_31800_STARTUP_MODE==="LIVE"){
 // One invocation during Render process boot. Never block server readiness.
 setTimeout(()=>{run().catch(e=>event("UNHANDLED_FAIL_CLOSED",{error:String(e.message).slice(0,120)}));},5000);
}
