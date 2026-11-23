import fetch from "node-fetch";
import crypto from "node:crypto";

const VERSION="CF_SV7_26800_READONLY_PREVIEW_V1_20261123";
const SKU="cf-sv7-i5-8gb-ssd256";
const ASIN="B0GH73M1BH";
const MARKETPLACE="A1VC38T7YXB528";
const EXPECTED=Object.freeze({normal:29800,min:22000,sale:26800,days:7});
const clone=x=>JSON.parse(JSON.stringify(x));
const number=x=>x===null||x===undefined||x===""?null:Number(x);
const audience=x=>String(x?.audience?.value||x?.audience||"ALL").toUpperCase();
const digest=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const log=(stage,details={})=>console.log("CF_SV7_26800_PRICE_TEST "+JSON.stringify({version:VERSION,stage,...details,externalChanges:0}));
function active(o,key,now) {
 const schedules=o?.[key]?.[0]?.schedule||[];
 return schedules.filter(s=>(!s.start_at||Date.parse(s.start_at)<=now)&&(!s.end_at||Date.parse(s.end_at)>now))
   .sort((a,b)=>(Date.parse(b.start_at||0)||0)-(Date.parse(a.start_at||0)||0))[0]||null;
}
export function parse(listing,now=Date.now()) {
 const summary=listing.summaries?.[0]||{};
 const offers=listing.attributes?.purchasable_offer||[];
 const all=offers.filter(x=>audience(x)==="ALL");
 const b2b=offers.filter(x=>audience(x)==="B2B");
 const c=all[0],b=b2b[0];
 return {
   asin:summary.asin,productType:summary.productType,statuses:summary.status||[],
   qty:number(listing.fulfillmentAvailability?.[0]?.quantity),
   errorCodes:(listing.issues||[]).filter(x=>String(x.severity).toUpperCase()==="ERROR").map(x=>x.code),
   offers,allCount:all.length,b2bCount:b2b.length,
   normal:number(active(c,"our_price",now)?.value_with_tax),
   min:number(active(c,"minimum_seller_allowed_price",now)?.value_with_tax),
   sale:number(active(c,"discounted_price",now)?.value_with_tax),
   b2bPrice:number(active(b,"our_price",now)?.value_with_tax)
 };
}
export function plan(listing,now=Date.now()) {
 const s=parse(listing,now),blocks=[];
 if(s.asin!==ASIN)blocks.push("ASIN_MISMATCH");
 if(s.productType!=="NOTEBOOK_COMPUTER")blocks.push("PRODUCT_TYPE_MISMATCH");
 if(s.allCount!==1||s.b2bCount>1||s.offers.length!==s.allCount+s.b2bCount)blocks.push("UNEXPECTED_OFFER_AUDIENCES");
 if(!s.statuses.includes("BUYABLE"))blocks.push("NOT_BUYABLE");
 if(s.errorCodes.length)blocks.push("LISTING_ERRORS");
 if(!(s.qty>0))blocks.push("NO_AVAILABLE_QUANTITY");
 if(s.normal!==EXPECTED.normal)blocks.push("NORMAL_PRICE_DRIFT");
 if(s.min!==EXPECTED.min)blocks.push("SELLER_MINIMUM_DRIFT");
 if(s.sale!==null)blocks.push("ACTIVE_SALE_CONFLICT");
 if(!(EXPECTED.sale>s.min&&EXPECTED.sale<s.normal))blocks.push("TARGET_PRICE_OUTSIDE_ALLOWED_RANGE");
 const future=s.offers.filter(x=>audience(x)==="ALL")
   .flatMap(x=>x.discounted_price||[]).flatMap(x=>x.schedule||[])
   .filter(x=>!x.start_at||Date.parse(x.start_at)>now);
 if(future.length)blocks.push("FUTURE_SALE_CONFLICT");
 if(blocks.length)return {s,blocks};
 const offers=clone(s.offers),i=offers.findIndex(x=>audience(x)==="ALL");
 const start=new Date(now-60_000).toISOString(),end=new Date(now+7*86_400_000).toISOString();
 offers[i].discounted_price=[{schedule:[{value_with_tax:EXPECTED.sale,start_at:start,end_at:end}]}];
 const withoutSale=xs=>xs.map(x=>{const y=clone(x);if(audience(y)==="ALL")delete y.discounted_price;return y;});
 if(JSON.stringify(withoutSale(offers))!==JSON.stringify(withoutSale(s.offers)))blocks.push("UNRELATED_OFFER_MUTATION");
 if(JSON.stringify(offers.filter(x=>audience(x)==="B2B"))!==JSON.stringify(s.offers.filter(x=>audience(x)==="B2B")))blocks.push("B2B_MUTATION");
 return {s,blocks,offers,start,end};
}
export function economics(cost,points=298) {
 return {cost,points,contributionAt26800:Math.round(EXPECTED.sale*.9-cost-1250-2000-points)};
}
function settings(){
 const seller=String(process.env.SPAPI_SELLER_ID||"");
 const marketplace=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE);
 const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
 if(!seller||marketplace!==MARKETPLACE||!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint))throw Error("CONFIG_INVALID");
 const {LWA_CLIENT_ID,LWA_CLIENT_SECRET,REFRESH_TOKEN}=process.env;
 if(!LWA_CLIENT_ID||!LWA_CLIENT_SECRET||!REFRESH_TOKEN)throw Error("LWA_ENV_MISSING");
 return {seller,marketplace,endpoint,LWA_CLIENT_ID,LWA_CLIENT_SECRET,REFRESH_TOKEN};
}
async function token(config){
 const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:config.LWA_CLIENT_ID,client_secret:config.LWA_CLIENT_SECRET,refresh_token:config.REFRESH_TOKEN}),signal:AbortSignal.timeout(20_000)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok||!d.access_token)throw Error("LWA_HTTP_"+r.status);
 return d.access_token;
}
async function spapi(config,access,method,payload=null){
 const q=new URLSearchParams({marketplaceIds:config.marketplace,issueLocale:"ja_JP"});
 if(method==="GET")q.set("includedData","summaries,attributes,issues,fulfillmentAvailability");
 if(method==="PATCH")q.set("mode","VALIDATION_PREVIEW");
 const url=config.endpoint+"/listings/2021-08-01/items/"+encodeURIComponent(config.seller)+"/"+encodeURIComponent(SKU)+"?"+q.toString();
 const r=await fetch(url,{method,headers:{"x-amz-access-token":access,accept:"application/json",...(payload?{"content-type":"application/json"}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(30_000)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok){
  const issues=(Array.isArray(d.issues)?d.issues:Array.isArray(d.errors)?d.errors:[]);
  const codes=issues.map(x=>String(x.code||"UNKNOWN").slice(0,30));
  const detail=String(d.message||issues[0]?.message||"").replace(/[A-Za-z0-9_-]{28,}/g,"[REDACTED]").slice(0,150);
  throw Error("SPAPI_"+method+"_"+r.status+"_"+JSON.stringify({codes,detail}));
 }
 return {http:r.status,data:d};
}
export async function run(){
 if(process.env.CF_SV7_26800_PREVIEW_MODE!=="READ_ONLY")return {status:"DISABLED"};
 try{
  const cfg=settings(),access=await token(cfg);
  const before=(await spapi(cfg,access,"GET")).data;
  const p=plan(before),s=p.s;
  if(p.blocks.length){
   log("PREFLIGHT_BLOCKED",{blocks:p.blocks,normal:s.normal,min:s.min,sale:s.sale,b2b:s.b2bPrice,qty:s.qty,errors:s.errorCodes});
   return {status:"PREFLIGHT_BLOCKED",blocks:p.blocks};
  }
  const beforeHash=digest(before.attributes?.purchasable_offer||[]);
  const patch={productType:s.productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:p.offers}]};
  const v=await spapi(cfg,access,"PATCH",patch);
  const issues=Array.isArray(v.data.issues)?v.data.issues:[];
  const failures=issues.filter(x=>String(x.severity).toUpperCase()==="ERROR");
  if(v.data.status!=="VALID"||failures.length){
   log("VALIDATION_REJECTED",{http:v.http,status:String(v.data.status||"UNKNOWN"),issueCodes:issues.map(x=>String(x.code||"").slice(0,30))});
   return {status:"VALIDATION_REJECTED"};
  }
  const after=(await spapi(cfg,access,"GET")).data;
  const s2=parse(after);
  const noMutation=beforeHash===digest(after.attributes?.purchasable_offer||[]) &&
    s2.normal===s.normal&&s2.min===s.min&&s2.sale===s.sale&&s2.b2bPrice===s.b2bPrice&&s2.qty===s.qty;
  if(!noMutation){log("DRIFT_AFTER_PREVIEW",{normal:s2.normal,min:s2.min,sale:s2.sale,b2b:s2.b2bPrice,qty:s2.qty});return {status:"DRIFT_AFTER_PREVIEW"}}
  log("VALIDATION_PREVIEW_PASS_NO_MUTATION",{sku:SKU,asin:ASIN,http:v.http,normal:s.normal,min:s.min,sale:s.sale,b2b:s.b2bPrice,quantity:s.qty,listingErrors:s.errorCodes,proposedSale:EXPECTED.sale,proposedDurationDays:7,estimatedMeanProfit:economics(16953),estimatedHighCostProfit:economics(19600)});
  return {status:"VALIDATION_PREVIEW_PASS_NO_MUTATION"};
 }catch(e){
  log("FAILED_CLOSED",{error:String(e?.message||e).slice(0,300)});
  return {status:"FAILED_CLOSED"};
 }
}
if(process.env.CF_SV7_26800_PREVIEW_MODE==="READ_ONLY")
 setTimeout(()=>{run().catch(e=>log("UNHANDLED_FAIL_CLOSED",{error:String(e?.message||e).slice(0,150)}));},5000);
