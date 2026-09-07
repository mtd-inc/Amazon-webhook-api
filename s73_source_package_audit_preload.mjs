import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION="2026-09-07-s73-source-package-audit-v1.0.0";
const MARKETPLACE_ID="A1VC38T7YXB528";
const SOURCE_SKU="7X-725F-2ZML";
const SOURCE_ASIN="B0HGDBYRS8";
const REQUEST_TIMEOUT_MS=20000;
const originalListen=express.application.listen;
let autoRunStarted=false;

function jparse(t){try{return t?JSON.parse(t):{};}catch{return {rawText:String(t||"").slice(0,3000)};}}
function cfg(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId)throw new Error("Missing env: SPAPI_SELLER_ID");
  if(marketplaceId!==MARKETPLACE_ID)throw new Error(`marketplace mismatch ${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function ft(url,opt={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);try{return await fetch(url,{...opt,signal:c.signal});}finally{clearTimeout(t);}}
async function token(){
  const clientId=process.env.LWA_CLIENT_ID,clientSecret=process.env.LWA_CLIENT_SECRET,refreshToken=process.env.REFRESH_TOKEN;
  if(!clientId||!clientSecret||!refreshToken)throw new Error("Missing LWA env");
  const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
  const x=jparse(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA token error ${r.status}`);return x.access_token;
}
async function req(url,a){const r=await ft(url,{headers:{"x-amz-access-token":a,accept:"application/json"}});return {http:r.status,ok:r.ok,body:jparse(await r.text())};}
async function run(){
  const a=await token();const {sellerId,marketplaceId,endpoint}=cfg();
  const lq=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  const listing=await req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SOURCE_SKU)}?${lq}`,a);
  if(!listing.ok)throw new Error(`listing GET ${listing.http}`);
  const attrs=listing.body?.attributes||{};
  const cq=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"attributes,dimensions,identifiers,productTypes,summaries"});
  const catalog=await req(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(SOURCE_ASIN)}?${cq}`,a);
  return {
    ok:true,moduleVersion:MODULE_VERSION,readOnly:true,externalChanges:0,
    listing:{http:listing.http,sku:listing.body?.sku||"",asin:listing.body?.summaries?.[0]?.asin||"",relevant:{
      list_price:attrs.list_price||null,
      item_package_dimensions:attrs.item_package_dimensions||null,
      item_package_weight:attrs.item_package_weight||null,
      item_dimensions:attrs.item_dimensions||null,
      item_weight:attrs.item_weight||null,
      product_dimensions:attrs.product_dimensions||null,
      item_dimensions_unit:attrs.item_dimensions_unit||null,
      item_weight_unit:attrs.item_weight_unit||null
    }},
    catalog:{http:catalog.http,ok:catalog.ok,dimensions:catalog.body?.dimensions||null,summaries:catalog.body?.summaries||null,attributes:catalog.body?.attributes?{
      list_price:catalog.body.attributes.list_price||null,
      item_package_dimensions:catalog.body.attributes.item_package_dimensions||null,
      item_package_weight:catalog.body.attributes.item_package_weight||null,
      item_dimensions:catalog.body.attributes.item_dimensions||null,
      item_weight:catalog.body.attributes.item_weight||null
    }:null}
  };
}
express.application.listen=function s73SourcePackageAuditListen(...args){
  const server=originalListen.apply(this,args);
  if(!autoRunStarted){autoRunStarted=true;setTimeout(async()=>{try{console.log("S73_SOURCE_PACKAGE_AUDIT_RESULT="+JSON.stringify(await run()));}catch(err){console.error("S73_SOURCE_PACKAGE_AUDIT_ERROR="+(err?.message||String(err)));}},2200);}return server;
};
