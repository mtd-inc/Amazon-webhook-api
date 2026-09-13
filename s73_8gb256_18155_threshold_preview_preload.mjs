import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION="2026-09-13-s73-8gb256-18155-threshold-preview-v1.0.0";
const ROUTE="/amazon/price/s73/8gb256-18155-threshold-preview";
const TOKEN="S73_8GB256_18155_THRESHOLD_V121_20260913";
const originalListen=express.application.listen;
const TARGET=Object.freeze({
  sku:"s73-hs-i5-11g-8gb-ssd256", asin:"B0HJL5MCV9",
  min:28100, candidates:[35800,36800,37800,38800,39800,40800,42800]
});

const clone=v=>JSON.parse(JSON.stringify(v));
const parse=t=>{try{return t?JSON.parse(t):{};}catch{return {rawText:String(t||"").slice(0,1500)}}};
const secret=()=>String(process.env.AMAZON_STOCK_API_SECRET||"").trim();
function cfg(){const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID");return {sellerId,marketplaceId:String(process.env.SPAPI_MARKETPLACE_ID||"A1VC38T7YXB528").trim(),endpoint:String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"")};}
async function lwa(){const {LWA_CLIENT_ID:client_id,LWA_CLIENT_SECRET:client_secret,REFRESH_TOKEN:refresh_token}=process.env;if(!client_id||!client_secret||!refresh_token)throw new Error("Missing LWA env");const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token,client_id,client_secret})});const j=parse(await r.text());if(!r.ok||!j.access_token)throw new Error(`LWA ${r.status}`);return j.access_token;}
async function req(url,opt){const r=await fetch(url,opt);const j=parse(await r.text());if(!r.ok)throw new Error(`SPAPI ${r.status} ${JSON.stringify(j).slice(0,1800)}`);return {r,j};}
async function getListing(token){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});const u=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;return (await req(u,{headers:{"x-amz-access-token":token,accept:"application/json"}})).j;}
const audience=o=>String(o?.audience||"ALL").toUpperCase();
const cIndex=offers=>offers.findIndex(x=>audience(x)!=="B2B");
const value=(o,k)=>{const n=Number(o?.[k]?.[0]?.schedule?.[0]?.value_with_tax??NaN);return Number.isFinite(n)?n:null;};
async function preview(token,listing,price){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const summary=Array.isArray(listing?.summaries)?listing.summaries[0]||{}:{};
  if(String(summary.asin||"")!==TARGET.asin)throw new Error(`ASIN_MISMATCH ${summary.asin||""}`);
  const before=clone(Array.isArray(listing?.attributes?.purchasable_offer)?listing.attributes.purchasable_offer:[]);
  const after=clone(before);const beforeB2B=before.filter(x=>audience(x)==="B2B");let i=cIndex(after);
  if(i<0){after.push({currency:"JPY",audience:"ALL",our_price:[{schedule:[{value_with_tax:price}]}],minimum_seller_allowed_price:[{schedule:[{value_with_tax:TARGET.min}]}],marketplace_id:marketplaceId});i=after.length-1;}
  else{after[i].currency=after[i].currency||"JPY";after[i].audience=after[i].audience||"ALL";after[i].marketplace_id=after[i].marketplace_id||marketplaceId;after[i].our_price=[{schedule:[{value_with_tax:price}]}];after[i].minimum_seller_allowed_price=[{schedule:[{value_with_tax:TARGET.min}]}];}
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  const u=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  const body={productType:String(summary.productType||"NOTEBOOK_COMPUTER"),patches:[{op:"replace",path:"/attributes/purchasable_offer",value:after}]};
  const {r,j}=await req(u,{method:"PATCH",headers:{"x-amz-access-token":token,accept:"application/json","content-type":"application/json"},body:JSON.stringify(body)});
  const issues=Array.isArray(j?.issues)?j.issues:[];const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
  return {price,min:TARGET.min,httpStatus:r.status,responseStatus:String(j?.status||""),submissionId:String(j?.submissionId||""),errorCount:errors.length,issueCodes:issues.map(x=>String(x?.code||"")).filter(Boolean),issue18155Count:errors.filter(x=>String(x?.code||"")==="18155").length,b2bPreserved:JSON.stringify(beforeB2B)===JSON.stringify(after.filter(x=>audience(x)==="B2B")),validationPassed:r.ok&&errors.length===0};
}
async function handler(req,res){
  try{
    const s=secret();if(!s)return res.status(500).json({ok:false,externalChanges:0,error:"AMAZON_STOCK_API_SECRET missing"});
    if(String(req.headers["x-api-secret"]||"")!==s)return res.status(401).json({ok:false,externalChanges:0,error:"Unauthorized"});
    if(String(req.body?.token||"")!==TOKEN)throw new Error("GUARD_BLOCKED invalid token");
    if(req.body?.live===true)throw new Error("LIVE_DISABLED preview only");
    const access=await lwa();const listing=await getListing(access);const summary=listing?.summaries?.[0]||{};
    const currentOffer=(Array.isArray(listing?.attributes?.purchasable_offer)?listing.attributes.purchasable_offer:[])[cIndex(Array.isArray(listing?.attributes?.purchasable_offer)?listing.attributes.purchasable_offer:[])]||null;
    const currentIssues=Array.isArray(listing?.issues)?listing.issues:[];
    const probes=[];for(const price of TARGET.candidates){probes.push(await preview(access,listing,price));}
    const firstPass=probes.find(x=>x.validationPassed&&x.b2bPreserved)||null;
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,sku:TARGET.sku,asin:TARGET.asin,current:{price:value(currentOffer,"our_price"),min:value(currentOffer,"minimum_seller_allowed_price"),statuses:Array.isArray(summary.status)?summary.status:[],issueCodes:currentIssues.map(x=>String(x?.code||"")).filter(Boolean)},targetMin:TARGET.min,candidates:TARGET.candidates,firstPassingPrice:firstPass?.price??null,probes,safety:{mode:"VALIDATION_PREVIEW",persistentAmazonWrites:0,liveCalls:0,externalChanges:0},externalChanges:0});
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:err?.message||String(err)});}
}

express.application.listen=function s73ThresholdPreviewListen(...args){const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);return originalListen.apply(this,args);};
