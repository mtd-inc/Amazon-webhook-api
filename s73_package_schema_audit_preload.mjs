import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MARKETPLACE_ID="A1VC38T7YXB528";
const PRODUCT_TYPE="NOTEBOOK_COMPUTER";
const originalListen=express.application.listen;
let once=false;
function j(t){try{return t?JSON.parse(t):{};}catch{return {rawText:t};}}
async function token(){const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:process.env.REFRESH_TOKEN,client_id:process.env.LWA_CLIENT_ID,client_secret:process.env.LWA_CLIENT_SECRET})});const x=j(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA ${r.status}`);return x.access_token;}
async function run(){
 const a=await token();
 const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
 const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
 const q=new URLSearchParams({sellerId,marketplaceIds:MARKETPLACE_ID,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});
 const d=await fetch(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`,{headers:{"x-amz-access-token":a,accept:"application/json"}});const dj=j(await d.text());
 const u=String(dj?.schema?.link?.resource||"");if(!u)throw new Error("schema link missing");
 const s=await fetch(u,{headers:{accept:"application/json"}});const schema=j(await s.text());
 const pick=k=>schema?.properties?.[k]||null;
 console.log("S73_PACKAGE_SCHEMA_AUDIT_RESULT="+JSON.stringify({item_package_dimensions:pick("item_package_dimensions"),item_package_weight:pick("item_package_weight")}));
}
express.application.listen=function(...args){const server=originalListen.apply(this,args);if(!once){once=true;setTimeout(()=>run().catch(e=>console.error("S73_PACKAGE_SCHEMA_AUDIT_ERROR="+(e?.message||e))),2200);}return server;};
