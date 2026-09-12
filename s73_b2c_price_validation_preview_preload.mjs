import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-12-s73-b2c-price-validation-preview-v1.0.0";
const ROUTE = "/amazon/price/s73/b2c-validation-preview";
const BATCH_TOKEN = "S73_B2C_PRICE_6_20260912_V1";
const originalListen = express.application.listen;
const marketplaceDefault = "A1VC38T7YXB528";

const TARGETS = Object.freeze([
  {sku:"s73-hs-i5-11g-8gb-ssd256",asin:"B0HJL5MCV9",price:35800,min:35500},
  {sku:"s73-hs-i5-11g-8gb-ssd512",asin:"B0HJLDDQQ3",price:49800,min:42400},
  {sku:"s73-hs-i5-11g-8gb-ssd1tb",asin:"B0HJL3QKXR",price:64800,min:56900},
  {sku:"7X-725F-2ZML",asin:"B0HGDBYRS8",price:43800,min:39600},
  {sku:"s73-hs-i5-11g-16gb-ssd512",asin:"B0HJ28YCP7",price:54800,min:54000},
  {sku:"s73-hs-i5-11g-16gb-ssd1tb",asin:"B0HJL1TP7L",price:69800,min:68500},
]);

function safeJsonParse(text){try{return text?JSON.parse(text):{};}catch{return {rawText:text};}}
function clone(v){return JSON.parse(JSON.stringify(v));}
function getSecret(){return String(process.env.AMAZON_STOCK_API_SECRET||"").trim();}
function getConfig(){const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim(); if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID"); return {sellerId,marketplaceId:String(process.env.SPAPI_MARKETPLACE_ID||marketplaceDefault).trim(),endpoint:String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"")};}
async function getLwaAccessToken(){
  const {LWA_CLIENT_ID:client_id,LWA_CLIENT_SECRET:client_secret,REFRESH_TOKEN:refresh_token}=process.env;
  if(!client_id||!client_secret||!refresh_token)throw new Error("Missing LWA env");
  const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token,client_id,client_secret})});
  const j=safeJsonParse(await r.text()); if(!r.ok||!j.access_token)throw new Error(`LWA ${r.status}`); return j.access_token;
}
async function amazonRequest(url,options){const r=await fetch(url,options); const j=safeJsonParse(await r.text()); if(!r.ok)throw new Error(`SPAPI ${r.status} ${JSON.stringify(j).slice(0,1800)}`); return {r,j};}
async function getListing(token,sku){const {sellerId,marketplaceId,endpoint}=getConfig(); const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"}); const u=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`; return (await amazonRequest(u,{headers:{"x-amz-access-token":token,accept:"application/json"}})).j;}
function audience(offer){return String(offer?.audience||"ALL").toUpperCase();}
function consumerIndex(offers){return offers.findIndex(x=>audience(x)!=="B2B");}
function getScheduleValue(offer,key){return Number(offer?.[key]?.[0]?.schedule?.[0]?.value_with_tax ?? NaN);}
function makeConsumer(price,min,marketplaceId){return {currency:"JPY",audience:"ALL",our_price:[{schedule:[{value_with_tax:price}]}],minimum_seller_allowed_price:[{schedule:[{value_with_tax:min}]}],marketplace_id:marketplaceId};}
async function preview(token,target,listing){
  const {sellerId,marketplaceId,endpoint}=getConfig();
  const summary=Array.isArray(listing?.summaries)?listing.summaries[0]||{}:{};
  const attrs=listing?.attributes||{}; const before=clone(Array.isArray(attrs.purchasable_offer)?attrs.purchasable_offer:[]); const after=clone(before);
  const beforeB2B=before.filter(x=>audience(x)==="B2B"); let i=consumerIndex(after);
  if(i<0){after.push(makeConsumer(target.price,target.min,marketplaceId)); i=after.length-1;} else {after[i].currency=after[i].currency||"JPY"; after[i].audience=after[i].audience||"ALL"; after[i].marketplace_id=after[i].marketplace_id||marketplaceId; after[i].our_price=[{schedule:[{value_with_tax:target.price}]}]; after[i].minimum_seller_allowed_price=[{schedule:[{value_with_tax:target.min}]}];}
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"}); const u=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}?${q}`;
  const body={productType:String(summary.productType||"NOTEBOOK_COMPUTER"),patches:[{op:"replace",path:"/attributes/purchasable_offer",value:after}]}; const {r,j}=await amazonRequest(u,{method:"PATCH",headers:{"x-amz-access-token":token,accept:"application/json","content-type":"application/json"},body:JSON.stringify(body)});
  const issues=Array.isArray(j?.issues)?j.issues:[]; const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR"); const currentConsumer=before[consumerIndex(before)]||null;
  return {sku:target.sku,asin:target.asin,currentPrice:Number.isFinite(getScheduleValue(currentConsumer,"our_price"))?getScheduleValue(currentConsumer,"our_price"):null,currentMin:Number.isFinite(getScheduleValue(currentConsumer,"minimum_seller_allowed_price"))?getScheduleValue(currentConsumer,"minimum_seller_allowed_price"):null,targetPrice:target.price,targetMin:target.min,maximumSellerAllowed:Number.isFinite(getScheduleValue(currentConsumer,"maximum_seller_allowed_price"))?getScheduleValue(currentConsumer,"maximum_seller_allowed_price"):null,statuses:Array.isArray(summary.status)?summary.status:[],listingErrorCount:(Array.isArray(listing?.issues)?listing.issues:[]).filter(x=>String(x?.severity||"").toUpperCase()==="ERROR").length,b2bPreserved:JSON.stringify(beforeB2B)===JSON.stringify(after.filter(x=>audience(x)==="B2B")),httpStatus:r.status,responseStatus:String(j?.status||""),submissionId:String(j?.submissionId||""),previewErrorCount:errors.length,previewIssueCodes:issues.map(x=>String(x?.code||"")).filter(Boolean),validationPassed:r.ok&&errors.length===0,externalChanges:0};
}
async function handler(req,res){
  const fetchedAt=new Date().toISOString();
  try{
    const secret=getSecret(); if(!secret)return res.status(500).json({ok:false,error:"AMAZON_STOCK_API_SECRET missing",externalChanges:0});
    if(String(req.headers["x-api-secret"]||"")!==secret)return res.status(401).json({ok:false,error:"Unauthorized",externalChanges:0});
    if(String(req.body?.batchToken||"")!==BATCH_TOKEN)throw new Error("GUARD_BLOCKED invalid batchToken");
    if(req.body?.dryRun===false)throw new Error("LIVE_DISABLED validation preview only");
    const token=await getLwaAccessToken(); const results=[];
    for(const target of TARGETS){const listing=await getListing(token,target.sku); const asin=String(listing?.summaries?.[0]?.asin||""); if(asin!==target.asin)throw new Error(`ASIN_MISMATCH ${target.sku} ${asin}`); results.push(await preview(token,target,listing));}
    const passed=results.filter(x=>x.validationPassed&&x.b2bPreserved).length;
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,batchToken:BATCH_TOKEN,fetchedAt,decision:passed===TARGETS.length?"S73_B2C_VALIDATION_PREVIEW_ALL_6_PASS":"S73_B2C_VALIDATION_PREVIEW_HAS_ERRORS",previewCalls:results.length,validationPassedCount:passed,validationFailedCount:results.length-passed,safety:{mode:"VALIDATION_PREVIEW",persistentAmazonWrites:0,liveCalls:0,externalChanges:0},results,externalChanges:0});
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,batchToken:BATCH_TOKEN,decision:"STOP_EXCEPTION",previewCalls:0,externalChanges:0,error:err?.message||String(err)});}
}

express.application.listen=function s73B2CPriceValidationPreviewListen(...args){const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE)); if(!exists)this.post(ROUTE,handler); return originalListen.apply(this,args);};

