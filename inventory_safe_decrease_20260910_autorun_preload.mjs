import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION="2026-09-10-inventory-safe-decrease-v1.0.2";
const FRESH="/amazon/stock/fresh-get";
const UPDATE="/amazon/stock/update";
const ORDERS="/amazon/orders/fresh-gate";
const TARGETS=[
  {sku:"cf-sv9-i5-8gb-ssd256",asin:"B0GH6ZT2X2",before:8,target:7},
  {sku:"55-4W0H-JKMS",asin:"B0FQCTDLG1",before:8,target:7},
  {sku:"LeLib_SV9_8GB_SSD512",asin:"B0F1G6QTDZ",before:8,target:7},
  {sku:"RB-Y7G2-H0EK",asin:"B0GZGM1BND",before:2,target:1},
  {sku:"LeLib_SV1_16GB_SSD512",asin:"B0G5ZRLZZH",before:5,target:1}
];
const REVIEW={sku:"EI-8OK8-6YEV",asin:"B0H4VKB13S",target:1};
const oldListen=express.application.listen;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function post(port,path,secret,body){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:"POST",headers:{"content-type":"application/json","x-api-secret":secret},body:JSON.stringify(body)});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={rawText:t}}return{httpStatus:r.status,ok:r.ok,body:j};}
function indexFresh(resp){const m=new Map();for(const x of resp?.body?.results||[])m.set(x.sku,x);return m;}
function state(t,x){if(!x?.ok||x.asin!==t.asin||Number(x.errorCount)!==0)return"BLOCK";const q=Number(x.availableQuantity);if(q===t.target)return"ALREADY_TARGET";if(q===t.before)return"NEEDS_DECREASE";return"BLOCK";}
function afterGuard(t,x){return Boolean(x?.ok)&&x.asin===t.asin&&Number(x.availableQuantity)===t.target&&Number(x.errorCount)===0;}
async function auditL580(port,secret){
  const freshResp=await post(port,FRESH,secret,{skus:[REVIEW.sku]});
  const fresh=indexFresh(freshResp).get(REVIEW.sku)||null;
  const ordersResp=await post(port,ORDERS,secret,{skus:[REVIEW.sku],lookbackHours:168});
  const preview=await post(port,UPDATE,secret,{sku:REVIEW.sku,quantity:REVIEW.target,dryRun:true,reservation:false});
  const ordersOk=Boolean(ordersResp.ok&&ordersResp.body?.ok===true&&Number(ordersResp.body?.totalMatchingOpenQty||0)===0);
  const previewOk=Boolean(preview.ok&&preview.body?.ok===true&&preview.body?.dryRun===true&&String(preview.body?.result?.status||"")==="VALID");
  const freshOk=Boolean(fresh?.ok&&fresh.asin===REVIEW.asin&&Number(fresh.availableQuantity)===0&&Number(fresh.errorCount)===0&&fresh.discoverable===true);
  const ready=freshOk&&ordersOk&&previewOk;
  console.log(`L580_REVIEW_INCREASE_AUDIT=${JSON.stringify({status:ready?"READY_FOR_EXPLICIT_APPROVAL":"BLOCK",moduleVersion:VERSION,target:REVIEW,fresh,orders:{httpStatus:ordersResp.httpStatus,ok:ordersResp.ok,body:ordersResp.body},validationPreview:{httpStatus:preview.httpStatus,ok:preview.ok,body:preview.body},readyForExplicitApproval:ready,liveAllowed:false,liveBlockedReason:"EXPLICIT_USER_LIVE_APPROVAL_REQUIRED",amazonInventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`);
}
express.application.listen=function(...args){const server=oldListen.apply(this,args);const port=Number(process.env.PORT||10000),secret=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();setTimeout(async()=>{let writes=0;try{if(!secret)throw new Error("AMAZON_STOCK_API_SECRET_MISSING");const pre=await post(port,FRESH,secret,{skus:TARGETS.map(x=>x.sku)});if(!pre.ok||pre.body?.succeeded!==TARGETS.length)throw new Error(`FRESH_PREFLIGHT_FAILED:${JSON.stringify(pre)}`);const pmap=indexFresh(pre),plan=[];for(const t of TARGETS){const x=pmap.get(t.sku),s=state(t,x);plan.push({sku:t.sku,state:s,current:x?.availableQuantity??null,target:t.target});if(s==="BLOCK")throw new Error(`SAFE_DECREASE_GUARD_BLOCK:${t.sku}:${JSON.stringify(x)}`)}const todo=TARGETS.filter(t=>state(t,pmap.get(t.sku))==="NEEDS_DECREASE");const previews=[];for(const t of todo){const pv=await post(port,UPDATE,secret,{sku:t.sku,quantity:t.target,dryRun:true,reservation:false});previews.push({sku:t.sku,httpStatus:pv.httpStatus,ok:pv.ok,message:pv.body?.message||"",result:pv.body?.result||null});if(!pv.ok||pv.body?.ok!==true||pv.body?.dryRun!==true)throw new Error(`VALIDATION_PREVIEW_BLOCK:${t.sku}:${JSON.stringify(pv)}`);await sleep(250)}const live=[];for(const t of todo){const beforeOne=await post(port,FRESH,secret,{skus:[t.sku]}),x=indexFresh(beforeOne).get(t.sku),s=state(t,x);if(s==="ALREADY_TARGET"){live.push({sku:t.sku,action:"PRESERVE_ALREADY_TARGET",current:t.target});continue}if(s!=="NEEDS_DECREASE")throw new Error(`LAST_SECOND_GUARD_BLOCK:${t.sku}:${JSON.stringify(x)}`);const lv=await post(port,UPDATE,secret,{sku:t.sku,quantity:t.target,dryRun:false,reservation:false});live.push({sku:t.sku,action:"LIVE_DECREASE",target:t.target,httpStatus:lv.httpStatus,ok:lv.ok,message:lv.body?.message||"",result:lv.body?.result||null});if(!lv.ok||lv.body?.ok!==true||lv.body?.dryRun!==false)throw new Error(`LIVE_UPDATE_BLOCK:${t.sku}:${JSON.stringify(lv)}`);writes++;await sleep(500)}let finalMap=null,pass=false;for(let i=0;i<12;i++){const f=await post(port,FRESH,secret,{skus:TARGETS.map(x=>x.sku)});finalMap=indexFresh(f);if(TARGETS.every(t=>afterGuard(t,finalMap.get(t.sku)))){pass=true;break}await sleep(3000)}const final=TARGETS.map(t=>({sku:t.sku,asin:t.asin,target:t.target,fresh:finalMap?.get(t.sku)||null}));console.log(`INVENTORY_SAFE_DECREASE_20260910_RESULT=${JSON.stringify({status:pass?"SAFE_DECREASE_5_OF_5_PASS":"SAFE_DECREASE_POSTVERIFY_PENDING",moduleVersion:VERSION,plan,previews,live,final,amazonInventoryWrites:writes,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`);await auditL580(port,secret)}catch(e){console.error(`INVENTORY_SAFE_DECREASE_20260910_ERROR=${JSON.stringify({moduleVersion:VERSION,error:e?.message||String(e),amazonInventoryWrites:writes,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`);try{await auditL580(port,secret)}catch(a){console.error(`L580_REVIEW_INCREASE_AUDIT_ERROR=${JSON.stringify({moduleVersion:VERSION,error:a?.message||String(a),amazonInventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`)}}},5000);return server};
