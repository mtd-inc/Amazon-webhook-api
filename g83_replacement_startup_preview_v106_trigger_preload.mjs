import express from "express";
import fetch from "node-fetch";
import "dotenv/config";
const VERSION="2026-09-09-g83-replacement-startup-preview-v106-trigger-v1.0.0";
const PATH="/amazon/listing/g83-replacement-validation-preview-v106";
const oldListen=express.application.listen;
express.application.listen=function(...args){const server=oldListen.apply(this,args);const port=Number(process.env.PORT||10000),secret=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();setTimeout(async()=>{try{const r=await fetch(`http://127.0.0.1:${port}${PATH}`,{method:"POST",headers:{"content-type":"application/json","x-api-secret":secret},body:"{}"});const text=await r.text();console.log(`G83_REPLACEMENT_AUTO_PREVIEW_V106_RESULT=${JSON.stringify({version:VERSION,httpStatus:r.status,body:text})}`)}catch(e){console.error(`G83_REPLACEMENT_AUTO_PREVIEW_V106_ERROR=${JSON.stringify({version:VERSION,error:e?.message||String(e)})}`)}},3500);return server};
