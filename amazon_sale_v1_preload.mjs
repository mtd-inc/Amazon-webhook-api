import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "AMAZON_SALE_V1_0_0_20260918";
const PREVIEW_ROUTE = "/amazon/price/sale-v1/preview";
const LIVE_ROUTE = "/amazon/price/sale-v1/live";
const LIVE_CONFIRM = "AMAZON_SALE_V1_LIVE_EXPLICIT_APPROVAL";
const TTL_MS = 60 * 60 * 1000;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 1800;
const originalListen = express.application.listen;

const ALLOWED = Object.freeze({
  "cf-sv9-i5-8gb-ssd256": Object.freeze({
    asin:"B0GH6ZT2X2", normal:42000, targetSale:40700
  }),
  "Y3-30YC-UORU": Object.freeze({
    asin:"B0HGDZNVQN", normal:59800, targetSale:58000
  })
});

function secret(){ return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
function cfg(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||"A1VC38T7YXB528").trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId) throw new Error("SPAPI_SELLER_ID missing");
  return {sellerId,marketplaceId,endpoint};
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function clone(v){ return v===undefined?undefined:JSON.parse(JSON.stringify(v)); }
function num(v){ if(v===null||v===undefined||v==="") return null; const n=Number(v); return Number.isFinite(n)?n:null; }
function audience(o){ return String(o?.audience?.value||o?.audience||"ALL").toUpperCase(); }
function firstSchedule(o,key){ return o?.[key]?.[0]?.schedule?.[0]||null; }
function isoDateLike(v){
  const s=String(v||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(s)) return "";
  const t=Date.parse(s);
  return Number.isFinite(t)?s:"";
}
function assertDates(start,end){
  const a=isoDateLike(start), b=isoDateLike(end);
  if(!a||!b) throw Object.assign(new Error("startAt/endAt must be valid date or date-time"),{code:"SCOPE_MISMATCH"});
  if(Date.parse(b)<=Date.parse(a)) throw Object.assign(new Error("endAt must be after startAt"),{code:"SCOPE_MISMATCH"});
  return {startAt:a,endAt:b};
}
async function lwa(){
  const body=new URLSearchParams({
    grant_type:"refresh_token",
    refresh_token:String(process.env.REFRESH_TOKEN||""),
    client_id:String(process.env.LWA_CLIENT_ID||""),
    client_secret:String(process.env.LWA_CLIENT_SECRET||"")
  });
  const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  if(!r.ok) throw new Error("LWA failed "+r.status);
  return (await r.json()).access_token;
}
async function getListing(token,sku){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"attributes,summaries,issues,fulfillmentAvailability"});
  const r=await fetch(endpoint+"/listings/2021-08-01/items/"+encodeURIComponent(sellerId)+"/"+encodeURIComponent(sku)+"?"+q.toString(),{headers:{"x-amz-access-token":token,"accept":"application/json"}});
  const txt=await r.text(); let j={}; try{j=JSON.parse(txt)}catch{j={raw:txt}}
  if(!r.ok) throw new Error("getListingsItem failed "+r.status+" "+txt.slice(0,300));
  return j;
}
function analyze(spec,j){
  const s=Array.isArray(j?.summaries)?j.summaries[0]||{}:{};
  const issues=Array.isArray(j?.issues)?j.issues:[];
  const offers=Array.isArray(j?.attributes?.purchasable_offer)?clone(j.attributes.purchasable_offer):[];
  const ci=offers.findIndex(o=>audience(o)==="ALL");
  const bi=offers.findIndex(o=>audience(o)==="B2B");
  const c=ci>=0?offers[ci]:null, b=bi>=0?offers[bi]:null;
  const sale=firstSchedule(c,"discounted_price");
  return {
    asin:String(s.asin||""),
    statuses:Array.isArray(s.status)?s.status.map(String):[],
    errorCount:issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR").length,
    quantity:num(j?.fulfillmentAvailability?.[0]?.quantity)||0,
    offers,consumerIndex:ci,b2bIndex:bi,consumer:c,b2b:b,
    normal:num(firstSchedule(c,"our_price")?.value_with_tax),
    sale:num(sale?.value_with_tax),
    saleStart:String(sale?.start_at||""),
    saleEnd:String(sale?.end_at||""),
    min:num(firstSchedule(c,"minimum_seller_allowed_price")?.value_with_tax),
    max:num(firstSchedule(c,"maximum_seller_allowed_price")?.value_with_tax),
    b2bPrice:num(firstSchedule(b,"our_price")?.value_with_tax)
  };
}
function preflight(spec,state,targetSale){
  const e=[];
  if(state.asin!==spec.asin) e.push("ASIN");
  if(!state.statuses.includes("BUYABLE")) e.push("BUYABLE");
  if(state.errorCount!==0) e.push("ERROR="+state.errorCount);
  if(!(state.quantity>0)) e.push("QTY="+state.quantity);
  if(state.consumerIndex<0) e.push("CONSUMER_OFFER");
  if(state.normal!==spec.normal) e.push("NORMAL="+state.normal);
  if(targetSale!==spec.targetSale) e.push("SALE_SCOPE="+targetSale);
  if(state.min!==null && targetSale<state.min) e.push("SALE_BELOW_AMAZON_MIN");
  if(!(targetSale<state.normal)) e.push("SALE_NOT_BELOW_NORMAL");
  if(e.length) throw Object.assign(new Error("PREFLIGHT_FAILED: "+e.join(" / ")),{code:"PREFLIGHT_FAILED",details:e});
}
function buildOffers(state,targetSale,startAt,endAt){
  const before=clone(state.offers);
  const after=clone(state.offers);
  const c=after[state.consumerIndex];
  c.discounted_price=[{schedule:[{value_with_tax:targetSale,start_at:startAt,end_at:endAt}]}];
  const b0=clone(before), a0=clone(after);
  if(b0[state.consumerIndex]) delete b0[state.consumerIndex].discounted_price;
  if(a0[state.consumerIndex]) delete a0[state.consumerIndex].discounted_price;
  if(JSON.stringify(b0)!==JSON.stringify(a0)) throw new Error("NON_SALE_ATTRIBUTE_MUTATION_DETECTED");
  return after;
}
async function patch(token,sku,offers,validationOnly){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP"});
  if(validationOnly) q.set("mode","VALIDATION_PREVIEW");
  const body={productType:"PRODUCT",patches:[{op:"replace",path:"/attributes/purchasable_offer",value:offers}]};
  const r=await fetch(endpoint+"/listings/2021-08-01/items/"+encodeURIComponent(sellerId)+"/"+encodeURIComponent(sku)+"?"+q.toString(),{
    method:"PATCH",headers:{"x-amz-access-token":token,"content-type":"application/json","accept":"application/json"},body:JSON.stringify(body)
  });
  const txt=await r.text(); let j={}; try{j=JSON.parse(txt)}catch{j={raw:txt}}
  return {http:r.status,ok:r.ok,body:j};
}
function makeFingerprint(p){
  const enc=Buffer.from(JSON.stringify({...p,issuedAt:Date.now()})).toString("base64url");
  const sig=crypto.createHmac("sha256",secret()).update(enc).digest("base64url");
  return enc+"."+sig;
}
function verifyFingerprint(token,expected){
  const [enc,sig]=String(token||"").split(".");
  if(!enc||!sig) throw Object.assign(new Error("dryRunFingerprint required"),{code:"FINGERPRINT_REQUIRED"});
  const exp=crypto.createHmac("sha256",secret()).update(enc).digest("base64url");
  const a=Buffer.from(sig),b=Buffer.from(exp);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) throw Object.assign(new Error("fingerprint mismatch"),{code:"FINGERPRINT_MISMATCH"});
  const p=JSON.parse(Buffer.from(enc,"base64url").toString("utf8"));
  if(Date.now()-Number(p.issuedAt||0)>TTL_MS) throw Object.assign(new Error("fingerprint expired"),{code:"FINGERPRINT_EXPIRED"});
  for(const k of ["sku","asin","normal","targetSale","startAt","endAt"]) if(String(p[k])!==String(expected[k])) throw Object.assign(new Error("fingerprint scope mismatch "+k),{code:"FINGERPRINT_SCOPE"});
  return p;
}
async function verifyApplied(token,spec,targetSale,startAt,endAt){
  let last=null;
  for(let i=1;i<=VERIFY_ATTEMPTS;i++){
    const state=analyze(spec,await getListing(token,spec.sku||""));
    last=state;
    if(state.sale===targetSale && state.saleStart===startAt && state.saleEnd===endAt && state.normal===spec.normal) return {verified:true,attempt:i,state};
    if(i<VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return {verified:false,attempt:VERIFY_ATTEMPTS,state:last};
}
function scope(body){
  const sku=String(body?.sku||"").trim(), spec0=ALLOWED[sku];
  if(!spec0) throw Object.assign(new Error("SKU not allowed"),{code:"SCOPE_MISMATCH"});
  const targetSale=num(body?.targetSale);
  const d=assertDates(body?.startAt,body?.endAt);
  const spec={...spec0,sku};
  if(targetSale!==spec.targetSale) throw Object.assign(new Error("targetSale does not match approved candidate"),{code:"SCOPE_MISMATCH"});
  return {spec,targetSale,...d};
}
async function previewHandler(req,res){
  try{
    if(!secret()) return res.status(500).json({ok:false,status:"CONFIG_ERROR",externalChanges:0});
    if(String(req.headers["x-api-secret"]||"")!==secret()) return res.status(401).json({ok:false,status:"UNAUTHORIZED",externalChanges:0});
    const x=scope(req.body), token=await lwa(), state=analyze(x.spec,await getListing(token,x.spec.sku));
    preflight(x.spec,state,x.targetSale);
    const offers=buildOffers(state,x.targetSale,x.startAt,x.endAt);
    const v=await patch(token,x.spec.sku,offers,true);
    if(!v.ok || String(v.body?.status||"")!=="VALID") return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,status:"VALIDATION_FAILED",validation:v,externalChanges:0});
    const fp=makeFingerprint({sku:x.spec.sku,asin:x.spec.asin,normal:x.spec.normal,targetSale:x.targetSale,startAt:x.startAt,endAt:x.endAt});
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,status:"DRY_RUN_READY",sku:x.spec.sku,asin:x.spec.asin,before:{normal:state.normal,sale:state.sale,min:state.min,max:state.max,b2bPrice:state.b2bPrice,quantity:state.quantity},targetSale:x.targetSale,startAt:x.startAt,endAt:x.endAt,validation:v.body,dryRunFingerprint:fp,fingerprintTtlMinutes:60,liveConfirm:LIVE_CONFIRM,externalChanges:0});
  }catch(e){return res.status(e.code==="SCOPE_MISMATCH"?400:409).json({ok:false,moduleVersion:MODULE_VERSION,status:e.code||"ERROR",error:e.message,details:e.details,externalChanges:0});}
}
async function liveHandler(req,res){
  try{
    if(!secret()) return res.status(500).json({ok:false,status:"CONFIG_ERROR",externalChanges:0});
    if(String(req.headers["x-api-secret"]||"")!==secret()) return res.status(401).json({ok:false,status:"UNAUTHORIZED",externalChanges:0});
    if(String(req.body?.confirm||"")!==LIVE_CONFIRM) return res.status(400).json({ok:false,status:"LIVE_CONFIRM_MISMATCH",externalChanges:0});
    const x=scope(req.body);
    verifyFingerprint(req.body?.dryRunFingerprint,{sku:x.spec.sku,asin:x.spec.asin,normal:x.spec.normal,targetSale:x.targetSale,startAt:x.startAt,endAt:x.endAt});
    const token=await lwa(), before=analyze(x.spec,await getListing(token,x.spec.sku));
    preflight(x.spec,before,x.targetSale);
    const offers=buildOffers(before,x.targetSale,x.startAt,x.endAt);
    const accepted=await patch(token,x.spec.sku,offers,false);
    if(!accepted.ok || String(accepted.body?.status||"")!=="ACCEPTED") return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,status:"LIVE_NOT_ACCEPTED",accepted,externalChanges:0});
    const verification=await verifyApplied(token,x.spec,x.targetSale,x.startAt,x.endAt);
    if(!verification.verified) return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,status:"VERIFICATION_FAILED",accepted:accepted.body,verification,externalChanges:1});
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,status:"COMPLETED",accepted:accepted.body,verification,externalChanges:1});
  }catch(e){return res.status(["SCOPE_MISMATCH","LIVE_CONFIRM_MISMATCH"].includes(e.code)?400:409).json({ok:false,moduleVersion:MODULE_VERSION,status:e.code||"ERROR",error:e.message,details:e.details,externalChanges:0});}
}

express.application.listen=function(...args){
  const hasPreview=Boolean(this?._router?.stack?.some(l=>l?.route?.path===PREVIEW_ROUTE));
  const hasLive=Boolean(this?._router?.stack?.some(l=>l?.route?.path===LIVE_ROUTE));
  if(!hasPreview) this.post(PREVIEW_ROUTE,previewHandler);
  if(!hasLive) this.post(LIVE_ROUTE,liveHandler);
  return originalListen.apply(this,args);
};
