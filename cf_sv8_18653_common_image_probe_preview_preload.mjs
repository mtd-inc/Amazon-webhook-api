import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-18653-image1-probe-preview-v1.0.0";
const TAG = "CF_SV8_18653_IMAGE1_PROBE_PREVIEW_RESULT";
const ERR = "CF_SV8_18653_IMAGE1_PROBE_PREVIEW_ERROR";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const TARGETS = Object.freeze([
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd1", asin: "B0GH7CDB3Y" }),
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd256", asin: "B0GH792325" }),
]);
const CANDIDATES = Object.freeze([1]);

const parse = t => { try { return t ? JSON.parse(t) : {}; } catch { return { rawText: String(t).slice(0,4000) }; } };
function cfg(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId) throw new Error("SELLER_ID_MISSING");
  if(marketplaceId!==MARKETPLACE_ID) throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function lwa(){
  const {LWA_CLIENT_ID:client_id,LWA_CLIENT_SECRET:client_secret,REFRESH_TOKEN:refresh_token}=process.env;
  if(!client_id||!client_secret||!refresh_token) throw new Error("LWA_ENV_MISSING");
  const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token,client_id,client_secret})});
  const j=parse(await r.text()); if(!r.ok||!j.access_token) throw new Error(`LWA_FAILED:${r.status}`); return j.access_token;
}
async function getListing(a,sku){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues",issueLocale:"ja_JP"});
  const r=await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,{headers:{"x-amz-access-token":a,accept:"application/json"}});
  const j=parse(await r.text()); if(!r.ok) throw new Error(`GET_FAILED:${sku}:${r.status}`); return j;
}
async function previewDelete(a,target,productType,attributeName,value){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  const body={productType,patches:[{op:"delete",path:`/attributes/${attributeName}`,value}]};
  const r=await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}?${q}`,{method:"PATCH",headers:{"x-amz-access-token":a,"content-type":"application/json",accept:"application/json"},body:JSON.stringify(body)});
  const j=parse(await r.text());
  const issues=Array.isArray(j?.issues)?j.issues:[];
  const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
  return {httpStatus:r.status,responseOk:r.ok,status:String(j?.status||""),submissionId:String(j?.submissionId||""),errorCount:errors.length,issueCodes:errors.map(x=>String(x?.code||"")),issues,requestBody:body};
}
async function run(){
  const a=await lwa(); const results=[];
  for(const target of TARGETS){
    const fresh=await getListing(a,target.sku);
    const s=Array.isArray(fresh?.summaries)?fresh.summaries[0]||{}:{};
    const asin=String(s?.asin||""); if(asin!==target.asin) throw new Error(`ASIN_MISMATCH:${target.sku}:${asin}`);
    const productType=String(s?.productType||""); if(productType!=="NOTEBOOK_COMPUTER") throw new Error(`PRODUCT_TYPE_MISMATCH:${target.sku}:${productType}`);
    const errors=(Array.isArray(fresh?.issues)?fresh.issues:[]).filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
    if(!errors.some(x=>String(x?.code||"")==="18653")) throw new Error(`18653_NOT_PRESENT:${target.sku}`);
    const attrs=fresh?.attributes||{}; const probes=[];
    for(const n of CANDIDATES){
      const attributeName=`other_product_image_locator_${n}`;
      const raw=attrs?.[attributeName];
      if(!Array.isArray(raw)||raw.length!==1) { probes.push({slot:n,attributeName,skipped:true,reason:"ATTRIBUTE_NOT_SINGLETON"}); continue; }
      const value=raw.map(v=>({media_location:String(v?.media_location||""),marketplace_id:String(v?.marketplace_id||MARKETPLACE_ID)}));
      const preview=await previewDelete(a,target,productType,attributeName,value);
      probes.push({slot:n,attributeName,mediaLocation:value[0].media_location,preview});
    }
    results.push({sku:target.sku,asin,statuses:Array.isArray(s?.status)?s.status:[],freshErrorCodes:errors.map(x=>String(x?.code||"")),probes});
  }
  console.log(`${TAG}=${JSON.stringify({status:"CF_SV8_18653_IMAGE1_PROBE_PREVIEW_COMPLETE",moduleVersion:MODULE_VERSION,validationPreviewOnly:true,liveImplemented:false,results,amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0})}`);
}
run().catch(e=>console.error(`${ERR}=${JSON.stringify({status:"FAILED",moduleVersion:MODULE_VERSION,validationPreviewOnly:true,liveImplemented:false,error:e?.message||String(e),amazonPersistentWrites:0,externalChanges:0})}`));
