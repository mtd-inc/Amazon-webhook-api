import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-18653-image1-live-v1.0.0";
const TAG = "CF_SV8_18653_IMAGE1_LIVE_RESULT";
const ERR = "CF_SV8_18653_IMAGE1_LIVE_ERROR";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const ISSUE_CODE = "18653";
const ATTRIBUTE_NAME = "other_product_image_locator_1";

const TARGETS = Object.freeze([
  Object.freeze({
    sku: "cf-sv8-i5-8gb-ssd1",
    asin: "B0GH7CDB3Y",
    mediaLocation: "https://m.media-amazon.com/images/I/71Ll8zkDNBL.jpg",
    approvedPreviewSubmissionId: "fe9ea73a203743a3951a073b61714532",
    approvedRequestBodySha256: "c292cd67ac7e570b26efe45ac1c4cf287cdc7b2208f2f58216d72abe2a685686",
  }),
  Object.freeze({
    sku: "cf-sv8-i5-8gb-ssd256",
    asin: "B0GH792325",
    mediaLocation: "https://m.media-amazon.com/images/I/71sWnNuHdxL.jpg",
    approvedPreviewSubmissionId: "d31eed27c3bc49d8baccf493f217181c",
    approvedRequestBodySha256: "91dbcc1d0beb1ecee87801ef9358ce39e7d1576168b5dd86a4b2277e59aacc58",
  }),
]);

const parse = t => { try { return t ? JSON.parse(t) : {}; } catch { return { rawText: String(t).slice(0,4000) }; } };
const sha256 = obj => crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");

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
  const j=parse(await r.text());
  if(!r.ok||!j.access_token) throw new Error(`LWA_FAILED:${r.status}`);
  return j.access_token;
}

async function getListing(a,sku){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues",issueLocale:"ja_JP"});
  const r=await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,{headers:{"x-amz-access-token":a,accept:"application/json"}});
  const j=parse(await r.text());
  if(!r.ok) throw new Error(`GET_FAILED:${sku}:${r.status}`);
  return j;
}

async function liveDelete(a,target,requestBody){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});
  const r=await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}?${q}`,{method:"PATCH",headers:{"x-amz-access-token":a,"content-type":"application/json",accept:"application/json"},body:JSON.stringify(requestBody)});
  const j=parse(await r.text());
  return {httpStatus:r.status,responseOk:r.ok,status:String(j?.status||""),submissionId:String(j?.submissionId||""),issues:Array.isArray(j?.issues)?j.issues:[],raw:j};
}

function buildGuardedRequest(target,fresh){
  const s=Array.isArray(fresh?.summaries)?fresh.summaries[0]||{}:{};
  if(String(fresh?.sku||"")!==target.sku) throw new Error(`SKU_MISMATCH:${target.sku}:${String(fresh?.sku||"")}`);
  if(String(s?.asin||"")!==target.asin) throw new Error(`ASIN_MISMATCH:${target.sku}:${String(s?.asin||"")}`);
  if(String(s?.productType||"")!==PRODUCT_TYPE) throw new Error(`PRODUCT_TYPE_MISMATCH:${target.sku}:${String(s?.productType||"")}`);

  const errors=(Array.isArray(fresh?.issues)?fresh.issues:[]).filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
  if(!errors.some(x=>String(x?.code||"")===ISSUE_CODE)) throw new Error(`18653_NOT_PRESENT:${target.sku};LIVE_NOT_SENT`);

  const raw=fresh?.attributes?.[ATTRIBUTE_NAME];
  if(!Array.isArray(raw)||raw.length!==1) throw new Error(`ATTRIBUTE_NOT_SINGLETON:${target.sku}`);
  const currentUrl=String(raw[0]?.media_location||"");
  const currentMarketplace=String(raw[0]?.marketplace_id||MARKETPLACE_ID);
  if(currentUrl!==target.mediaLocation) throw new Error(`IMAGE_URL_MISMATCH:${target.sku}:${currentUrl}`);
  if(currentMarketplace!==MARKETPLACE_ID) throw new Error(`IMAGE_MARKETPLACE_MISMATCH:${target.sku}:${currentMarketplace}`);

  const requestBody={productType:PRODUCT_TYPE,patches:[{op:"delete",path:`/attributes/${ATTRIBUTE_NAME}`,value:[{media_location:currentUrl,marketplace_id:currentMarketplace}]}]};
  const requestBodySha256=sha256(requestBody);
  if(requestBodySha256!==target.approvedRequestBodySha256) throw new Error(`APPROVED_HASH_MISMATCH:${target.sku}:${requestBodySha256}`);
  return {requestBody,requestBodySha256,freshErrorCodes:errors.map(x=>String(x?.code||"")),statuses:Array.isArray(s?.status)?s.status:[]};
}

async function run(){
  if(globalThis.__CF_SV8_18653_IMAGE1_LIVE_ALREADY_RAN__) return;
  globalThis.__CF_SV8_18653_IMAGE1_LIVE_ALREADY_RAN__=true;

  const a=await lwa();
  const results=[];
  let persistentWrites=0;

  for(const target of TARGETS){
    try {
      const freshBefore=await getListing(a,target.sku);
      const plan=buildGuardedRequest(target,freshBefore);
      const live=await liveDelete(a,target,plan.requestBody);
      const liveErrors=live.issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
      const accepted=live.responseOk && liveErrors.length===0 && ["ACCEPTED","VALID"].includes(String(live.status||"").toUpperCase());
      if(accepted) persistentWrites+=1;
      results.push({sku:target.sku,asin:target.asin,approvedPreviewSubmissionId:target.approvedPreviewSubmissionId,requestBodySha256:plan.requestBodySha256,freshErrorCodesBefore:plan.freshErrorCodes,statusesBefore:plan.statuses,live:{httpStatus:live.httpStatus,responseOk:live.responseOk,status:live.status,submissionId:live.submissionId,errorCount:liveErrors.length,issueCodes:liveErrors.map(x=>String(x?.code||"")),issues:live.issues},accepted});
    } catch(e){
      results.push({sku:target.sku,asin:target.asin,accepted:false,error:e?.message||String(e)});
    }
  }

  console.log(`${TAG}=${JSON.stringify({status:"CF_SV8_18653_IMAGE1_LIVE_COMPLETE",moduleVersion:MODULE_VERSION,results,amazonPersistentWrites:persistentWrites,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:persistentWrites})}`);
}

run().catch(e=>console.error(`${ERR}=${JSON.stringify({status:"FAILED",moduleVersion:MODULE_VERSION,error:e?.message||String(e),inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`));
