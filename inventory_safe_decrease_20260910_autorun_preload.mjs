import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION="2026-09-10-inventory-safe-decrease-v1.0.0";
const FRESH="/amazon/stock/fresh-get";
const UPDATE="/amazon/stock/update";
const TARGETS=[
  {sku:"cf-sv9-i5-8gb-ssd256",asin:"B0GH6ZT2X2",before:8,target:7},
  {sku:"55-4W0H-JKMS",asin:"B0FQCTDLG1",before:8,target:7},
  {sku:"LeLib_SV9_8GB_SSD512",asin:"B0F1G6QTDZ",before:8,target:7},
  {sku:"RB-Y7G2-H0EK",asin:"B0GZGM1BND",before:2,target:1},
  {sku:"LeLib_SV1_16GB_SSD512",asin:"B0G5ZRLZZH",before:5,target:1}
];
const oldListen=express.application.listen;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function post(port,path,secret,body){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:"POST",headers:{"content-type":"application/json","x-api-secret":secret},body:JSON.stringify(body)});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={rawText:t}}return{httpStatus:r.status,ok:r.ok,body:j};}
function indexFresh(resp){const m=new Map();for(const x of resp?.body?.results||[])m.set(x.sku,x);return m;}
function guard(t,x){return Boolean(x?.ok)&&x.asin===t.asin&&Number(x.availableQuantity)===t.before&&Number(x.errorCount)===0;}
function afterGuard(t,x){return Boolean(x?.ok)&&x.asin===t.asin&&Number(x.availableQuantity)===t.target&&Number(x.errorCount)===0;}
express.application.listen=function(...args){const server=oldListen.apply(this,args);const port=Number(process.env.PORT||10000),secret=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();setTimeout(async()=>{let writes=0;try{if(!secret)throw new Error("AMAZON_STOCK_API_SECRET_MISSING");const pre=await post(port,FRESH,secret,{skus:TARGETS.map(x=>x.sku)});if(!pre.ok||pre.body?.succeeded!==TARGETS.length)throw new Error(`FRESH_PREFLIGHT_FAILED:${JSON.stringify(pre)}`);const pmap=indexFresh(pre);const blocks=TARGETS.filter(t=>!guard(t,pmap.get(t.sku))).map(t=>({target:t,fresh:pmap.get(t.sku)||null}));if(blocks.length)throw new Error(`SAFE_DECREASE_GUARD_BLOCK:${JSON.stringify(blocks)}`);const previews=[];for(const t of TARGETS){const pv=await post(port,UPDATE,secret,{sku:t.sku,quantity:t.target,dryRun:true,reservation:false});previews.push({sku:t.sku,httpStatus:pv.httpStatus,ok:pv.ok,message:pv.body?.message||"",result:pv.body?.result||null});if(!pv.ok||pv.body?.ok!==true||pv.body?.dryRun!==true)throw new Error(`VALIDATION_PREVIEW_BLOCK:${t.sku}:${JSON.stringify(pv)}`);await sleep(250)}const live=[];for(const t of TARGETS){const beforeOne=await post(port,FRESH,secret,{skus:[t.sku]});const x=indexFresh(beforeOne).get(t.sku);if(!guard(t,x))throw new Error(`LAST_SECOND_GUARD_BLOCK:${t.sku}:${JSON.stringify(x)}`);const lv=await post(port,UPDATE,secret,{sku:t.sku,quantity:t.target,dryRun:false,reservation:false});live.push({sku:t.sku,target:t.target,httpStatus:lv.httpStatus,ok:lv.ok,message:lv.body?.message||"",result:lv.body?.result||null});if(!lv.ok||lv.body?.ok!==true||lv.body?.dryRun!==false)throw new Error(`LIVE_UPDATE_BLOCK:${t.sku}:${JSON.stringify(lv)}`);writes++;await sleep(500)}let finalResp=null,finalMap=null,pass=false;for(let i=0;i<12;i++){finalResp=await post(port,FRESH,secret,{skus:TARGETS.map(x=>x.sku)});finalMap=indexFresh(finalResp);if(TARGETS.every(t=>afterGuard(t,finalMap.get(t.sku)))){pass=true;break}await sleep(3000)}const final=TARGETS.map(t=>({sku:t.sku,asin:t.asin,target:t.target,fresh:finalMap?.get(t.sku)||null}));console.log(`INVENTORY_SAFE_DECREASE_20260910_RESULT=${JSON.stringify({status:pass?"SAFE_DECREASE_5_OF_5_PASS":"SAFE_DECREASE_POSTVERIFY_PENDING",moduleVersion:VERSION,targets:TARGETS,preflight:TARGETS.map(t=>pmap.get(t.sku)),previews,live,final,amazonInventoryWrites:writes,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`)}catch(e){console.error(`INVENTORY_SAFE_DECREASE_20260910_ERROR=${JSON.stringify({moduleVersion:VERSION,error:e?.message||String(e),amazonInventoryWrites:writes,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0})}`)}},5000);return server};
