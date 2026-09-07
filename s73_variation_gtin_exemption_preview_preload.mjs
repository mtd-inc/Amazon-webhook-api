import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-07-s73-variation-gtin-exemption-preview-v1.0.0";
const ROUTE = "/amazon/listing/s73-variation-gtin-exemption-preview";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const SOURCE_SKU = "7X-725F-2ZML";
const SOURCE_ASIN = "B0HGDBYRS8";
const CHILD512_SKU = "s73-hs-i5-11g-16gb-ssd512";
const PARENT_SKU = "s73-hs-i5-11g-16gb-storage-parent";
const THEME = "HARD_DISK_SIZE";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;
let autoRunStarted = false;

function jparse(t){try{return t?JSON.parse(t):{};}catch{return {rawText:String(t||"").slice(0,3000)};}}
function clone(v){return JSON.parse(JSON.stringify(v));}
function cfg(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId)throw new Error("Missing env: SPAPI_SELLER_ID");
  if(marketplaceId!==MARKETPLACE_ID)throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function ft(url,opt={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);try{return await fetch(url,{...opt,signal:c.signal});}finally{clearTimeout(t);}}
async function token(){
  const clientId=process.env.LWA_CLIENT_ID,clientSecret=process.env.LWA_CLIENT_SECRET,refreshToken=process.env.REFRESH_TOKEN;
  if(!clientId||!clientSecret||!refreshToken)throw new Error("Missing LWA env");
  const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
  const x=jparse(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA token error ${r.status}`);return x.access_token;
}
async function req(url,a,opt={}){
  const r=await ft(url,{method:opt.method||"GET",headers:{"x-amz-access-token":a,accept:"application/json",...(opt.body?{"content-type":"application/json"}:{})},...(opt.body?{body:JSON.stringify(opt.body)}:{})});
  return {http:r.status,ok:r.ok,body:jparse(await r.text())};
}
async function getListing(a){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SOURCE_SKU)}?${q}`,a);
}
async function getSchema(a){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});
  const d=await req(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`,a);if(!d.ok)throw new Error(`PTD GET ${d.http}`);
  const u=String(d.body?.schema?.link?.resource||"");if(!u)throw new Error("PTD schema link missing");
  const r=await ft(u,{headers:{accept:"application/json"}});const x=jparse(await r.text());if(!r.ok)throw new Error(`PTD schema fetch ${r.status}`);return x;
}
function rawValues(spec){
  const out=[];const seen=new Set();
  (function walk(n,d){
    if(!n||typeof n!=="object"||d>7)return;
    if(Array.isArray(n)){n.forEach(x=>walk(x,d+1));return;}
    if(Array.isArray(n.enum))n.enum.forEach(v=>{const k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}});
    if(n.const!==undefined){const v=n.const;const k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}
    ["items","properties","oneOf","anyOf","allOf"].forEach(k=>walk(n[k],d+1));
  })(spec,0);return out;
}
function nestedProp(s,name,child){return s?.properties?.[name]?.items?.properties?.[child]||null;}
function pickBoolean(spec,want,label){
  if(!spec)throw new Error(`PTD_MISSING ${label}`);
  const allowed=rawValues(spec);
  if(allowed.some(v=>v===want))return {value:want,allowed,schemaType:String(spec.type||"")};
  const text=String(want).toLowerCase();
  const match=allowed.find(v=>String(v).toLowerCase()===text);
  if(match!==undefined)return {value:match,allowed,schemaType:String(spec.type||"")};
  if(String(spec.type||"").toLowerCase()==="boolean")return {value:want,allowed,schemaType:"boolean"};
  throw new Error(`PTD_NO_${String(want).toUpperCase()} ${label} allowed=${JSON.stringify(allowed.slice(0,20))}`);
}
function values(spec){return rawValues(spec).map(v=>String(v));}
function setValue(attrs,name,value){if(!Array.isArray(attrs[name])||!attrs[name][0])throw new Error(`missing ${name}`);attrs[name]=clone(attrs[name]);attrs[name][0].value=value;}
function replaceSize(rows,field,newGB){
  const x=clone(rows||[]);if(!x.length)throw new Error(`missing ${field}`);
  if(field==="hard_disk"){
    if(!Array.isArray(x[0].size)||!x[0].size[0])throw new Error("hard_disk.size shape missing");
    x[0].size[0].value=newGB;x[0].size[0].unit="GB";
  }else{
    if(!Array.isArray(x[0].installed_size)||!x[0].installed_size[0])throw new Error("flash_memory.installed_size shape missing");
    x[0].installed_size[0].value=newGB;x[0].installed_size[0].unit="GB";
  }
  return x;
}
function stripIdentity(attrs){delete attrs.externally_assigned_product_identifier;delete attrs.merchant_suggested_asin;}
function stripImages(attrs){for(const k of Object.keys(attrs)){if(k==="main_product_image_locator"||/^other_product_image_locator_/i.test(k))delete attrs[k];}}
function relationRows(kind,relationship){
  const base={parentage_level:[{marketplace_id:MARKETPLACE_ID,value:kind}],variation_theme:[{name:THEME}]};
  if(kind==="child")base.child_parent_sku_relationship=[{marketplace_id:MARKETPLACE_ID,child_relationship_type:relationship,parent_sku:PARENT_SKU}];
  return base;
}
function attrPatch(attrs,key,value){return {op:Array.isArray(attrs?.[key])&&attrs[key].length?"replace":"add",path:`/attributes/${key}`,value};}
function child256Patches(attrs,relationship,exclusiveRows){
  const rel=relationRows("child",relationship);
  const out=Object.entries(rel).map(([k,v])=>attrPatch(attrs,k,v));
  out.push(attrPatch(attrs,"is_exclusive_product",clone(exclusiveRows)));
  return out;
}
function parentAttrs(src,exclusiveRows){
  const a=clone(src);
  for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin","purchasable_offer","fulfillment_availability","condition_type","list_price","minimum_seller_allowed_price","maximum_seller_allowed_price","merchant_shipping_group","hard_disk","flash_memory","child_parent_sku_relationship","parentage_level","variation_theme"])delete a[k];
  stripImages(a);
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み");
  a.is_exclusive_product=clone(exclusiveRows);
  a.parentage_level=[{marketplace_id:MARKETPLACE_ID,value:"parent"}];
  a.variation_theme=[{name:THEME}];
  return a;
}
function child512Attrs(src,exclusiveRows,exemptionRows,relationship){
  const a=clone(src);stripIdentity(a);stripImages(a);
  a.hard_disk=replaceSize(a.hard_disk,"hard_disk",512);
  a.flash_memory=replaceSize(a.flash_memory,"flash_memory",512);
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD512GB Win11 Pro ノートン・Office付");
  a.is_exclusive_product=clone(exclusiveRows);
  a.supplier_declared_has_product_identifier_exemption=clone(exemptionRows);
  Object.assign(a,relationRows("child",relationship));
  return a;
}
async function patchPreview(a,sku,patches){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:PRODUCT_TYPE,patches}});
}
async function putPreview(a,sku,attrs){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PUT",body:{productType:PRODUCT_TYPE,requirements:"LISTING",attributes:attrs}});
}
function sum(r){
  const issues=Array.isArray(r?.body?.issues)?r.body.issues:[];
  const errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR");
  const status=String(r?.body?.status||"").toUpperCase();
  return {httpStatus:r.http,responseOk:r.ok,status,issueCount:issues.length,errorCount:errors.length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],errors:errors.slice(0,10).map(i=>({code:String(i?.code||""),message:String(i?.message||"").slice(0,500),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(status)};
}
async function runPreview(){
  const a=await token();
  const listing=await getListing(a);if(!listing.ok)throw new Error(`source listing GET ${listing.http}`);
  const s=listing.body?.summaries?.[0]||{},attrs=listing.body?.attributes||{};
  if(String(listing.body?.sku||"")!==SOURCE_SKU)throw new Error("SOURCE_SKU_MISMATCH");
  if(String(s.asin||"")!==SOURCE_ASIN)throw new Error("SOURCE_ASIN_MISMATCH");
  if(String(s.productType||"")!==PRODUCT_TYPE)throw new Error("SOURCE_PRODUCT_TYPE_MISMATCH");
  const schema=await getSchema(a);
  const themes=values(nestedProp(schema,"variation_theme","name"));
  if(!themes.includes(THEME))throw new Error(`PTD_THEME_MISSING ${THEME}`);
  const parentVals=values(nestedProp(schema,"parentage_level","value"));
  if(!parentVals.some(v=>/^parent$/i.test(v))||!parentVals.some(v=>/^child$/i.test(v)))throw new Error(`PTD_PARENTAGE_INVALID ${JSON.stringify(parentVals)}`);
  const relVals=values(nestedProp(schema,"child_parent_sku_relationship","child_relationship_type"));
  const relationship=relVals.find(v=>/variation/i.test(v));if(!relationship)throw new Error(`PTD_RELATIONSHIP_INVALID ${JSON.stringify(relVals)}`);
  const exclusive=pickBoolean(nestedProp(schema,"is_exclusive_product","value"),false,"is_exclusive_product.value");
  const exemption=pickBoolean(nestedProp(schema,"supplier_declared_has_product_identifier_exemption","value"),true,"supplier_declared_has_product_identifier_exemption.value");
  const exclusiveRows=[{marketplace_id:MARKETPLACE_ID,value:exclusive.value}];
  const exemptionRows=[{marketplace_id:MARKETPLACE_ID,value:exemption.value}];
  const child256=sum(await patchPreview(a,SOURCE_SKU,child256Patches(attrs,relationship,exclusiveRows)));
  const parent=sum(await putPreview(a,PARENT_SKU,parentAttrs(attrs,exclusiveRows)));
  const child512=sum(await putPreview(a,CHILD512_SKU,child512Attrs(attrs,exclusiveRows,exemptionRows,relationship)));
  const ready=parent.valid&&child256.valid&&child512.valid;
  return {
    ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,status:ready?"PASS":"BLOCK",
    source:{sku:SOURCE_SKU,asin:SOURCE_ASIN,title:String(s.itemName||attrs?.item_name?.[0]?.value||""),productType:String(s.productType||"")},
    schemaSelection:{variationTheme:THEME,relationship,parentageValues:parentVals,gtinExemptionAttributePresent:Boolean(nestedProp(schema,"supplier_declared_has_product_identifier_exemption","value")),gtinExemptionValue:exemption.value,gtinExemptionAllowedValues:exemption.allowed.slice(0,10),isExclusiveProductValue:exclusive.value},
    preview:{parent,child256,child512},readyForLiveDesign:ready,
    next:ready?"PASS. Stop before LIVE and request explicit user approval.":"BLOCK. Inspect validation errors; no live mutation."
  };
}
async function handler(req,res){
  try{
    const secret=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();
    if(!secret)return res.status(500).json({ok:false,readOnly:true,externalChanges:0,error:"secret missing"});
    if(String(req.headers["x-api-secret"]||"")!==secret)return res.status(401).json({ok:false,readOnly:true,externalChanges:0,error:"Unauthorized"});
    if(req.body?.dryRun===false)throw new Error("LIVE disabled; validation preview only");
    return res.status(200).json(await runPreview());
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,error:err?.message||String(err)});}
}
express.application.listen=function s73GtinExemptionPreviewListen(...args){
  const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));
  if(!exists)this.post(ROUTE,handler);
  const server=originalListen.apply(this,args);
  if(!autoRunStarted){
    autoRunStarted=true;
    setTimeout(async()=>{
      try{console.log("S73_VARIATION_GTIN_EXEMPTION_PREVIEW_RESULT="+JSON.stringify(await runPreview()));}
      catch(err){console.error("S73_VARIATION_GTIN_EXEMPTION_PREVIEW_ERROR="+(err?.message||String(err)));}
    },2500);
  }
  return server;
};
