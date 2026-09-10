import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-10-cf-sv8-18653-postlive-audit-v1.0.0";
const TAG = "CF_SV8_18653_POSTLIVE_AUDIT_RESULT";
const ERR = "CF_SV8_18653_POSTLIVE_AUDIT_ERROR";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const ATTRIBUTE_NAME = "other_product_image_locator_1";
const TARGETS = Object.freeze([
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd1", asin: "B0GH7CDB3Y", removedUrl: "https://m.media-amazon.com/images/I/71Ll8zkDNBL.jpg", liveSubmissionId: "e83f6607eb5f4c0aa80dd0ab84c982dc" }),
  Object.freeze({ sku: "cf-sv8-i5-8gb-ssd256", asin: "B0GH792325", removedUrl: "https://m.media-amazon.com/images/I/71sWnNuHdxL.jpg", liveSubmissionId: "f54dce16c0f741f0a7a257bf7eb18a6f" }),
]);

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
async function run(){
  const a=await lwa();
  const results=[];
  for(const target of TARGETS){
    const fresh=await getListing(a,target.sku);
    const summary=Array.isArray(fresh?.summaries)?fresh.summaries[0]||{}:{};
    const errors=(Array.isArray(fresh?.issues)?fresh.issues:[]).filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
    const slot=Array.isArray(fresh?.attributes?.[ATTRIBUTE_NAME])?fresh.attributes[ATTRIBUTE_NAME]:[];
    const slotUrls=slot.map(x=>String(x?.media_location||""));
    const issueCodes=errors.map(x=>String(x?.code||""));
    results.push({
      sku:target.sku,
      expectedAsin:target.asin,
      asin:String(summary?.asin||""),
      asinMatches:String(summary?.asin||"")===target.asin,
      productType:String(summary?.productType||""),
      statuses:Array.isArray(summary?.status)?summary.status:[],
      liveSubmissionId:target.liveSubmissionId,
      removedUrl:target.removedUrl,
      targetSlotPresent:slotUrls.includes(target.removedUrl),
      slot1AttributePresent:slot.length>0,
      slot1Urls:slotUrls,
      errorCount:errors.length,
      issueCodes,
      issue18653Present:issueCodes.includes("18653"),
      errors:errors.map(x=>({code:String(x?.code||""),message:String(x?.message||""),enforcements:x?.enforcements||null})),
      pass:String(summary?.asin||"")===target.asin && !slotUrls.includes(target.removedUrl) && !issueCodes.includes("18653")
    });
  }
  console.log(`${TAG}=${JSON.stringify({status:"CF_SV8_18653_POSTLIVE_AUDIT_COMPLETE",moduleVersion:MODULE_VERSION,readOnly:true,results,allPass:results.every(x=>x.pass),amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0})}`);
}
run().catch(e=>console.error(`${ERR}=${JSON.stringify({status:"FAILED",moduleVersion:MODULE_VERSION,readOnly:true,error:e?.message||String(e),amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0})}`));
