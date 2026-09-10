import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION="2026-09-10-g83-replacement-final-audit-v1.0.0";
const MP="A1VC38T7YXB528";
const PT="NOTEBOOK_COMPUTER";
const PARENT_SKU="g83-hs-i5-11g-variation-parent";
const PARENT_ASIN="B0HHYNVYD5";
const THEME="HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const EXPECTED=[
 {sku:"SO-9QJ3-7SHR",asin:"B0FPC2JKBY"},
 {sku:"E7-YLJ3-F9CY",asin:"B0GZBHBQN2"},
 {sku:"5K-G098-FO9O",asin:"B0FPC52B8K"},
 {sku:"QH-ITJ6-BTTC",asin:"B0FPC385LM"},
 {sku:"g83-hs-i5-11g-8gb-ssd256-r1",asin:"B0HJ8L6KJY",ean:"4595989934973"},
 {sku:"g83-hs-i5-11g-8gb-ssd1tb-r1",asin:"B0HJ8SKQGG",ean:"4595989934980"}
];
const OLD_BAD=["B0FN3KQFR3","B0FPC4R7ZG"];
const oldListen=express.application.listen;
const jp=t=>{try{return t?JSON.parse(t):{};}catch{return{rawText:String(t||"").slice(0,4000)}}};
function cfg(){const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim(),marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MP).trim(),endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID");if(marketplaceId!==MP)throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);return{sellerId,marketplaceId,endpoint};}
async function ft(url,opt={}){const c=new AbortController(),tm=setTimeout(()=>c.abort(),25000);try{return await fetch(url,{...opt,signal:c.signal})}finally{clearTimeout(tm)}}
async function token(){const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:process.env.REFRESH_TOKEN,client_id:process.env.LWA_CLIENT_ID,client_secret:process.env.LWA_CLIENT_SECRET})});const x=jp(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA_${r.status}`);return x.access_token;}
async function req(url,a){const r=await ft(url,{headers:{"x-amz-access-token":a,accept:"application/json"}});return{http:r.status,ok:r.ok,body:jp(await r.text())};}
async function listing(a,sku){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues",issueLocale:"ja_JP"});return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a)}
async function catalog(a,asin){const {marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"relationships,summaries,productTypes"});return req(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`,a)}
function ids(at){return(Array.isArray(at?.externally_assigned_product_identifier)?at.externally_assigned_product_identifier:[]).map(x=>String(x?.value||"").trim()).filter(Boolean)}
function rel(at){return{parentage:at?.parentage_level?.[0]?.value||null,parentSku:at?.child_parent_sku_relationship?.[0]?.parent_sku||null,relationship:String(at?.child_parent_sku_relationship?.[0]?.child_relationship_type||""),theme:at?.variation_theme?.[0]?.name||null}}
function snap(t,r){if(!r.ok)return{sku:t.sku,asinExpected:t.asin,http:r.http,ok:false};const b=r.body||{},s=b.summaries?.[0]||{},at=b.attributes||{},issues=Array.isArray(b.issues)?b.issues:[];return{sku:t.sku,asinExpected:t.asin,asin:String(s.asin||""),productType:String(s.productType||""),ean:ids(at)[0]||null,errorCount:issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR").length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],relation:rel(at),ok:true}}
function childPass(t,s){return s.ok&&s.asin===t.asin&&s.productType===PT&&s.errorCount===0&&s.relation.parentage==="child"&&s.relation.parentSku===PARENT_SKU&&/^variation$/i.test(s.relation.relationship)&&s.relation.theme===THEME&&(!t.ean||s.ean===t.ean)}
function relAsins(node){const out=[];(function w(v,d){if(v==null||d>10)return;if(typeof v==="string"&&/^[A-Z0-9]{10}$/.test(v))out.push(v);else if(Array.isArray(v))v.forEach(x=>w(x,d+1));else if(typeof v==="object")Object.values(v).forEach(x=>w(x,d+1))})(node,0);return[...new Set(out)].sort()}
async function run(){const a=await token();const pl=await listing(a,PARENT_SKU);if(!pl.ok)throw new Error(`PARENT_LISTING_${pl.http}`);const ps=pl.body?.summaries?.[0]||{},pa=pl.body?.attributes||{},pi=Array.isArray(pl.body?.issues)?pl.body.issues:[];const parentListingPass=String(ps.asin||"")===PARENT_ASIN&&String(ps.productType||"")===PT&&pa?.parentage_level?.[0]?.value==="parent"&&pa?.variation_theme?.[0]?.name===THEME&&!pi.some(i=>String(i?.severity||"").toUpperCase()==="ERROR");const pc=await catalog(a,PARENT_ASIN);const parentAsins=relAsins(pc.body?.relationships||[]),expectedAsins=EXPECTED.map(x=>x.asin).sort();const children=[];for(const t of EXPECTED)children.push(snap(t,await listing(a,t.sku)));const childrenPass=EXPECTED.every(t=>childPass(t,children.find(x=>x.sku===t.sku)));const parentCatalogPass=pc.ok&&JSON.stringify(parentAsins)===JSON.stringify(expectedAsins)&&OLD_BAD.every(x=>!parentAsins.includes(x));const pass=parentListingPass&&childrenPass&&parentCatalogPass;return{status:pass?"CATALOG_6_OF_6_PASS":"G83_REPLACEMENT_FINAL_AUDIT_BLOCK",moduleVersion:VERSION,readOnly:true,parentListingPass,parentCatalogPass,childrenPass,parentAsins,expectedAsins,oldBadAbsent:OLD_BAD.every(x=>!parentAsins.includes(x)),children,amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0}}
express.application.listen=function(...args){const server=oldListen.apply(this,args);setTimeout(async()=>{try{console.log(`G83_REPLACEMENT_FINAL_AUDIT_RESULT=${JSON.stringify(await run())}`)}catch(e){console.error(`G83_REPLACEMENT_FINAL_AUDIT_ERROR=${JSON.stringify({moduleVersion:VERSION,error:e?.message||String(e),amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,yahooWrites:0,externalChanges:0})}`)}},5000);return server};
