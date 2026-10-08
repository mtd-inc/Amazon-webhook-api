import express from "express";
import fetch from "node-fetch";
import "dotenv/config";
import { TARGET, executeLive } from "./search_intelligence_generic_keyword_live_core.mjs";

const ROUTE="/amazon/listing/search-intelligence-generic-keyword-live";
const originalListen=express.application.listen;
let processAttempted=false;
const MARKETPLACE_ID="A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS=20000;
function secretEqual(a,b) {
  const x=Buffer.from(String(a||""));const y=Buffer.from(String(b||""));
  if(!x.length||x.length!==y.length) return false;
  return (awaitSafeEqual(x,y));
}
function awaitSafeEqual(x,y) {
  // All callers use byte arrays of equal length.
  return cryptoTimingSafeEqual(x,y);
}
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
function config() {
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  const controlPlane=String(process.env.SI_LIVE_CONTROL_PLANE_URL||"").replace(/\/$/,"");
  const controlSecret=String(process.env.SI_LIVE_CONTROL_PLANE_SECRET||"");
  if(!sellerId||!controlPlane.startsWith("https://")||!controlSecret) throw Error("LIVE_REQUIRED_CONFIG_MISSING");
  return {sellerId,endpoint,controlPlane,controlSecret};
}
async function callJson(url,options) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try {
    const response=await fetch(url,{...options,signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    return {response,data};
  } finally {clearTimeout(timer);}
}
async function token(){
  for(const key of ["LWA_CLIENT_ID","LWA_CLIENT_SECRET","REFRESH_TOKEN"])if(!process.env[key]) throw Error("LWA_CREDENTIAL_MISSING");
  const {response,data}=await callJson("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:process.env.REFRESH_TOKEN,client_id:process.env.LWA_CLIENT_ID,client_secret:process.env.LWA_CLIENT_SECRET})});
  if(!response.ok||!data.access_token) throw Error("LWA_REFRESH_FAILED");
  return data.access_token;
}
async function spApiRequest(accessToken,sku,productType,patches,mode) {
  const cfg=config();
  const q=new URLSearchParams({marketplaceIds:MARKETPLACE_ID,issueLocale:"ja_JP",includedData:mode==="GET"?"summaries,attributes,issues":"issues"});
  if(mode==="PREVIEW")q.set("mode","VALIDATION_PREVIEW");
  const url=cfg.endpoint+"/listings/2021-08-01/items/"+encodeURIComponent(cfg.sellerId)+"/"+encodeURIComponent(sku)+"?"+q;
  const method=mode==="GET"?"GET":"PATCH";
  const headers={"x-amz-access-token":accessToken,accept:"application/json"};
  const options={method,headers};
  if(method==="PATCH"){headers["content-type"]="application/json";options.body=JSON.stringify({productType,patches});}
  const {response,data}=await callJson(url,options);
  if(mode==="GET"){
    if(!response.ok)throw Error("FRESH_GET_HTTP_"+response.status);
    return data;
  }
  const issues=Array.isArray(data.issues)?data.issues:[];
  const errorCount=issues.filter(x=>String(x.severity||"").toUpperCase()==="ERROR").length;
  return {httpStatus:response.status,status:data.status||"",submissionId:data.submissionId||"",issueCount:issues.length,errorCount,valid:response.ok&&errorCount===0&&issues.length===0&&["VALID","ACCEPTED"].includes(String(data.status||"").toUpperCase())};
}
function gateBody(operation,input){
  return {operation,candidateId:input.candidateId,approvalId:input.approvalId,liveApprovalId:input.liveApprovalId,sellerSku:input.sku,asin:input.asin,targetField:input.field,currentValueHash:input.currentHash,proposedValueHash:input.proposedHash};
}
async function gate(operation,input) {
  const cfg=config();
  const {response,data}=await callJson(cfg.controlPlane+"/api/internal/commerce/search-intelligence/live-gate",{
    method:"POST",headers:{"content-type":"application/json","x-mtd-internal-control-plane-secret":cfg.controlSecret},
    body:JSON.stringify(gateBody(operation,input))
  });
  if(!response.ok||data.ok!==true||data.operation!==operation||data.approvalId!==input.approvalId)throw Error("CONTROL_PLANE_"+operation+"_BLOCKED");
  return true;
}
async function handler(req,res){
  let attempted=false;
  try {
    if(process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED!=="true")return res.status(503).json({ok:false,reason:"FEATURE_DISABLED",livePatchSent:false});
    if(!secretEqual(req.headers["x-si-live-secret"],process.env.SI_GENERIC_KEYWORD_LIVE_SECRET))return res.status(401).json({ok:false,error:"UNAUTHORIZED",livePatchSent:false});
    if(processAttempted)return res.status(409).json({ok:false,error:"PROCESS_LIVE_ATTEMPT_ALREADY_USED",livePatchSent:false});
    const input=req.body||{};
    const access=await token();
    const result=await executeLive({input,verifyProof:async body=>gate("VERIFY",body),reserve:async()=>gate("RESERVE",input),
      read:async()=>spApiRequest(access,TARGET.sku,null,null,"GET"),
      preview:async patches=>spApiRequest(access,TARGET.sku,"NOTEBOOK_COMPUTER",patches,"PREVIEW"),
      live:async patches=>{attempted=true;return spApiRequest(access,TARGET.sku,"NOTEBOOK_COMPUTER",patches,"LIVE");},
    });
    if(attempted)processAttempted=true;
    if(!result.liveAttempted)return res.status(409).json({ok:false,...result});
    const after=await spApiRequest(access,TARGET.sku,null,null,"GET").catch(()=>null);
    const value=after?.attributes?.generic_keyword?.[0]?.value;
    const verified=value===TARGET.proposed;
    return res.status(verified?200:202).json({ok:verified,livePatchSent:true,livePatchAttempts:1,postVerified:verified,verificationPending:!verified,liveResult:result.liveResult,warning:verified?null:"LIVE_SENT_DO_NOT_RETRY"});
  } catch(e){
    if(attempted)processAttempted=true;
    return res.status(409).json({ok:false,livePatchSent:attempted,livePatchAttempts:attempted?1:0,error:e instanceof Error?e.message:String(e),doNotRetry:attempted});
  }
}
express.application.listen=function(...args){
  const present=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));
  if(!present)this.post(ROUTE,handler);
  return originalListen.apply(this,args);
};
