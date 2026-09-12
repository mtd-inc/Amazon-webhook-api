import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const ROUTE = "/amazon/listing/g83-replacement-relationship-audit";
const MODULE_VERSION = "2026-09-12-g83-replacement-relationship-audit-v1.0.0";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const PARENT = { sku: "g83-hs-i5-11g-variation-parent", asin: "B0HHYNVYD5" };
const CHILDREN = [
  { sku: "g83-hs-i5-11g-8gb-ssd256-r1", asin: "B0HJ8L6KJY", spec: "8GB/256GB", role: "REPLACEMENT" },
  { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", spec: "8GB/512GB", role: "HEALTHY" },
  { sku: "g83-hs-i5-11g-8gb-ssd1tb-r1", asin: "B0HJ8SKQGG", spec: "8GB/1TB", role: "REPLACEMENT" },
  { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", spec: "16GB/256GB", role: "HEALTHY" },
  { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", spec: "16GB/512GB", role: "HEALTHY" },
  { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", spec: "16GB/1TB", role: "HEALTHY" }
];
const originalListen = express.application.listen;

function parse(text){ try{return text?JSON.parse(text):{};}catch{return {rawText:String(text||"").slice(0,1000)};} }
function cfg(){ const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim(); const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,""); if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID"); return {sellerId,endpoint}; }
async function token(){ const {LWA_CLIENT_ID, LWA_CLIENT_SECRET, REFRESH_TOKEN}=process.env; if(!LWA_CLIENT_ID||!LWA_CLIENT_SECRET||!REFRESH_TOKEN)throw new Error("Missing LWA env"); const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:REFRESH_TOKEN,client_id:LWA_CLIENT_ID,client_secret:LWA_CLIENT_SECRET})}); const x=parse(await r.text()); if(!r.ok||!x.access_token)throw new Error(`LWA ${r.status}`); return x.access_token; }
async function getJson(url,a){ const r=await fetch(url,{headers:{"x-amz-access-token":a,accept:"application/json"}}); return {http:r.status,ok:r.ok,body:parse(await r.text())}; }
async function listing(a,sku){ const {sellerId,endpoint}=cfg(); const q=new URLSearchParams({marketplaceIds:MARKETPLACE_ID,includedData:"summaries,attributes,issues",issueLocale:"ja_JP"}); return getJson(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a); }
async function catalog(a,asin){ const {endpoint}=cfg(); const q=new URLSearchParams({marketplaceIds:MARKETPLACE_ID,includedData:"attributes,images,productTypes,relationships,summaries"}); return getJson(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`,a); }
function first(rows,key="value"){ return Array.isArray(rows)&&rows[0]?rows[0]?.[key]??null:null; }
function rel(attrs){ return { parentageLevel:first(attrs?.parentage_level), parentSku:first(attrs?.child_parent_sku_relationship,"parent_sku"), childRelationshipType:first(attrs?.child_parent_sku_relationship,"child_relationship_type"), variationTheme:first(attrs?.variation_theme,"name") }; }
function issueSummary(x){ const issues=Array.isArray(x?.issues)?x.issues:[]; return {issueCount:issues.length,errorCount:issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR").length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))]}; }
function catalogParents(body){ const groups=Array.isArray(body?.relationships)?body.relationships:[]; const out=[]; for(const g of groups){ for(const r of (Array.isArray(g?.relationships)?g.relationships:[])){ if(String(r?.type||"").toUpperCase()==="PARENT") out.push(String(r?.asin||"")); } } return [...new Set(out.filter(Boolean))]; }
function catalogChildren(body){ const groups=Array.isArray(body?.relationships)?body.relationships:[]; const out=[]; for(const g of groups){ for(const r of (Array.isArray(g?.relationships)?g.relationships:[])){ if(String(r?.type||"").toUpperCase()==="CHILD") out.push(String(r?.asin||"")); } } return [...new Set(out.filter(Boolean))]; }

async function handler(req,res){
  try{
    const sec=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();
    if(!sec)return res.status(500).json({ok:false,readOnly:true,externalChanges:0,error:"secret missing"});
    if(String(req.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,readOnly:true,externalChanges:0,error:"Unauthorized"});
    if(req.body?.dryRun===false)throw new Error("LIVE disabled");
    const a=await token();
    const pr=await listing(a,PARENT.sku); const pc=await catalog(a,PARENT.asin);
    const ps=pr.body?.summaries?.[0]||{}; const pa=pr.body?.attributes||{};
    const rows=[];
    for(const c of CHILDREN){
      const lr=await listing(a,c.sku); const cr=await catalog(a,c.asin);
      const s=lr.body?.summaries?.[0]||{}; const attrs=lr.body?.attributes||{};
      rows.push({...c,listingHttp:lr.http,catalogHttp:cr.http,actualAsin:String(s.asin||""),productType:String(s.productType||""),status:Array.isArray(s.status)?s.status:[],relation:rel(attrs),catalogParents:catalogParents(cr.body),...issueSummary(lr.body)});
    }
    const parentChildren=catalogChildren(pc.body);
    const expectedAsins=CHILDREN.map(x=>x.asin);
    const linked=rows.filter(r=>r.relation.parentSku===PARENT.sku || r.catalogParents.includes(PARENT.asin));
    const exactSix=expectedAsins.every(a=>parentChildren.includes(a)) && parentChildren.filter(a=>expectedAsins.includes(a)).length===6;
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,priceWrites:0,inventoryWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,parent:{...PARENT,listingHttp:pr.http,catalogHttp:pc.http,actualAsin:String(ps.asin||""),productType:String(ps.productType||""),status:Array.isArray(ps.status)?ps.status:[],relation:rel(pa),catalogChildren:parentChildren,...issueSummary(pr.body)},children:rows,summary:{expectedChildCount:6,parentContainsExpectedCount:expectedAsins.filter(a=>parentChildren.includes(a)).length,childPointsToParentCount:linked.length,allChildrenErrorFree:rows.every(r=>r.errorCount===0),catalogSixOfSix:exactSix},liveAllowed:false,liveBlockedReason:"READ_ONLY_AUDIT"});
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,error:err?.message||String(err)});}
}

express.application.listen=function g83ReplacementRelationshipAuditListen(...args){
  const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));
  if(!exists)this.post(ROUTE,handler);
  return originalListen.apply(this,args);
};
