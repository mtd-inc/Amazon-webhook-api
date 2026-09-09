import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION="2026-09-09-g83-replacement-relation-live-v1.0.1";
const MP="A1VC38T7YXB528";
const PT="NOTEBOOK_COMPUTER";
const PARENT_SKU="g83-hs-i5-11g-variation-parent";
const PARENT_ASIN="B0HHYNVYD5";
const THEME="HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const TARGETS=[
  {sku:"g83-hs-i5-11g-8gb-ssd256-r1",asin:"B0HJ8L6KJY",ean:"4595989934973"},
  {sku:"g83-hs-i5-11g-8gb-ssd1tb-r1",asin:"B0HJ8SKQGG",ean:"4595989934980"}
];
const HEALTHY_EXISTING=["B0FPC2JKBY","B0GZBHBQN2","B0FPC52B8K","B0FPC385LM"];
const OLD_BAD=["B0FN3KQFR3","B0FPC4R7ZG"];
const EXPECTED=[...HEALTHY_EXISTING,...TARGETS.map(x=>x.asin)].sort();
const oldListen=express.application.listen;
const jp=t=>{try{return t?JSON.parse(t):{};}catch{return{rawText:String(t||"").slice(0,4000)}}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function cfg(){const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim(),marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MP).trim(),endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID");if(marketplaceId!==MP)throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);return{sellerId,marketplaceId,endpoint};}
async function ft(url,opt={}){const c=new AbortController(),tm=setTimeout(()=>c.abort(),25000);try{return await fetch(url,{...opt,signal:c.signal})}finally{clearTimeout(tm)}}
async function token(){const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:process.env.REFRESH_TOKEN,client_id:process.env.LWA_CLIENT_ID,client_secret:process.env.LWA_CLIENT_SECRET})});const x=jp(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA_${r.status}`);return x.access_token;}
async function req(url,a,opt={}){const r=await ft(url,{method:opt.method||"GET",headers:{"x-amz-access-token":a,accept:"application/json",...(opt.body?{"content-type":"application/json"}:{})},...(opt.body?{body:JSON.stringify(opt.body)}:{})});return{http:r.status,ok:r.ok,body:jp(await r.text())};}
async function listing(a,sku){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues",issueLocale:"ja_JP"});return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a)}
async function catalog(a,asin){const {marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"relationships,summaries,productTypes"});return req(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`,a)}
async function patch(a,sku,patches,preview){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});if(preview)q.set("mode","VALIDATION_PREVIEW");return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:PT,patches}})}
function ids(at){return(Array.isArray(at?.externally_assigned_product_identifier)?at.externally_assigned_product_identifier:[]).map(x=>String(x?.value||"").trim()).filter(Boolean)}
function rel(at){return{parentage:at?.parentage_level?.[0]?.value||null,parentSku:at?.child_parent_sku_relationship?.[0]?.parent_sku||null,relationship:String(at?.child_parent_sku_relationship?.[0]?.child_relationship_type||""),theme:at?.variation_theme?.[0]?.name||null}}
function childSnap(t,r){if(!r.ok)return{sku:t.sku,ok:false,http:r.http};const b=r.body||{},s=b.summaries?.[0]||{},at=b.attributes||{},issues=Array.isArray(b.issues)?b.issues:[];return{sku:t.sku,ok:true,asin:String(s.asin||""),productType:String(s.productType||""),ean:ids(at)[0]||null,errorCount:issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR").length,relation:rel(at)}}
function childHealthyStandalone(t,s){return s.ok&&s.asin===t.asin&&s.productType===PT&&s.ean===t.ean&&s.errorCount===0&&!s.relation.parentSku&&!s.relation.parentage&&!s.relation.theme}
function childAttached(t,s){return s.ok&&s.asin===t.asin&&s.productType===PT&&s.ean===t.ean&&s.errorCount===0&&s.relation.parentage==="child"&&s.relation.parentSku===PARENT_SKU&&/^variation$/i.test(s.relation.relationship)&&s.relation.theme===THEME}
function relationPatches(at){const op=k=>Array.isArray(at?.[k])&&at[k].length?"replace":"add";return[
 {op:op("parentage_level"),path:"/attributes/parentage_level",value:[{marketplace_id:MP,value:"child"}]},
 {op:op("variation_theme"),path:"/attributes/variation_theme",value:[{name:THEME}]},
 {op:op("child_parent_sku_relationship"),path:"/attributes/child_parent_sku_relationship",value:[{marketplace_id:MP,child_relationship_type:"variation",parent_sku:PARENT_SKU}]},
 {op:op("is_exclusive_product"),path:"/attributes/is_exclusive_product",value:[{marketplace_id:MP,value:false}]}
]}
function sum(r){const issues=Array.isArray(r?.body?.issues)?r.body.issues:[],errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR"),status=String(r?.body?.status||"").toUpperCase();return{httpStatus:r.http,status,errorCount:errors.length,errors:errors.map(i=>({code:i.code,message:String(i.message||"").slice(0,500),attributeNames:i.attributeNames||[]})),valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(status)}}
function relAsins(node){const out=[];(function w(v,d){if(v==null||d>10)return;if(typeof v==="string"&&/^[A-Z0-9]{10}$/.test(v))out.push(v);else if(Array.isArray(v))v.forEach(x=>w(x,d+1));else if(typeof v==="object")Object.values(v).forEach(x=>w(x,d+1))})(node,0);return[...new Set(out)].sort()}
async function parentState(a){const l=await listing(a,PARENT_SKU);if(!l.ok)throw new Error(`PARENT_LISTING_${l.http}`);const s=l.body?.summaries?.[0]||{},at=l.body?.attributes||{},issues=Array.isArray(l.body?.issues)?l.body.issues:[];if(String(s.asin||"")!==PARENT_ASIN||String(s.productType||"")!==PT||at?.parentage_level?.[0]?.value!=="parent"||at?.variation_theme?.[0]?.name!==THEME||issues.some(i=>String(i?.severity||"").toUpperCase()==="ERROR"))throw new Error("PARENT_GUARD_BLOCK");const c=await catalog(a,PARENT_ASIN);return{catalogHttp:c.http,asins:relAsins(c.body?.relationships||[])}}
async function run(){const a=await token();const beforeParent=await parentState(a);if(OLD_BAD.some(x=>beforeParent.asins.includes(x)))throw new Error(`OLD_BAD_STILL_IN_PARENT_CATALOG:${JSON.stringify(beforeParent.asins)}`);if(!HEALTHY_EXISTING.every(x=>beforeParent.asins.includes(x)))throw new Error(`HEALTHY_EXISTING_MISSING:${JSON.stringify(beforeParent.asins)}`);let writes=0;const actions=[];for(const t of TARGETS){const g=await listing(a,t.sku),s=childSnap(t,g);if(childAttached(t,s)){actions.push({sku:t.sku,action:"PRESERVE_ALREADY_ATTACHED",before:s});continue}if(!childHealthyStandalone(t,s))throw new Error(`TARGET_NOT_HEALTHY_STANDALONE:${t.sku}:${JSON.stringify(s)}`);const patches=relationPatches(g.body?.attributes||{});const pv=sum(await patch(a,t.sku,patches,true));if(!pv.valid)throw new Error(`RELATION_PREVIEW_BLOCK:${t.sku}:${JSON.stringify(pv)}`);const lv=sum(await patch(a,t.sku,patches,false));if(!lv.valid)throw new Error(`RELATION_LIVE_BLOCK:${t.sku}:${JSON.stringify(lv)}`);writes++;actions.push({sku:t.sku,action:"RELATION_LIVE_ACCEPTED",preview:pv,live:lv})}
let finalChildren=[],finalParent=null,pass=false;for(let i=0;i<18;i++){finalChildren=[];let kidsOk=true;for(const t of TARGETS){const s=childSnap(t,await listing(a,t.sku));finalChildren.push(s);if(!childAttached(t,s))kidsOk=false}finalParent=await parentState(a);const parentOk=JSON.stringify(finalParent.asins)===JSON.stringify(EXPECTED)&&OLD_BAD.every(x=>!finalParent.asins.includes(x));if(kidsOk&&parentOk){pass=true;break}await sleep(5000)}return{status:pass?"CATALOG_6_OF_6_PASS":"G83_REPLACEMENT_RELATION_PENDING",moduleVersion:VERSION,actions,beforeParent,expectedParentAsins:EXPECTED,finalChildren,finalParent,amazonPersistentWrites:writes,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:writes}}
express.application.listen=function(...args){const server=oldListen.apply(this,args);setTimeout(async()=>{try{console.log(`G83_REPLACEMENT_RELATION_LIVE_RESULT=${JSON.stringify(await run())}`)}catch(e){console.error(`G83_REPLACEMENT_RELATION_LIVE_ERROR=${JSON.stringify({moduleVersion:VERSION,error:e?.message||String(e),inventoryWrites:0,priceWrites:0,yahooWrites:0})}`)}},5000);return server};
