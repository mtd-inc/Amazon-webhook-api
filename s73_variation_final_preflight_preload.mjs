import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-07-s73-variation-final-preflight-v1.0.0";
const ROUTE = "/amazon/listing/s73-variation-final-preflight";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const SOURCE_SKU = "7X-725F-2ZML";
const SOURCE_ASIN = "B0HGDBYRS8";
const CHILD512_SKU = "s73-hs-i5-11g-16gb-ssd512";
const PARENT_SKU = "s73-hs-i5-11g-16gb-storage-parent";
const GTIN = "4595989934966";
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
async function getListing(a,sku){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a);
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
    if(Array.isArray(n.enum))for(const v of n.enum){const k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}
    if(n.const!==undefined){const v=n.const,k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}
    for(const k of ["items","properties","oneOf","anyOf","allOf"])walk(n[k],d+1);
  })(spec,0);return out;
}
function nestedSpec(s,n,c){return s?.properties?.[n]?.items?.properties?.[c]||null;}
function vals(s){return rawValues(s).map(String);}
function first(rows){return Array.isArray(rows)&&rows[0]?rows[0].value??null:null;}
function nestedMeasure(rows,key){return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0][key])&&rows[0][key][0]?rows[0][key][0]:null;}
function toGB(row){if(!row)return null;const v=Number(row.value);if(!Number.isFinite(v))return null;const u=String(row.unit||"GB").toUpperCase();return u==="TB"?v*1024:u==="MB"?v/1024:v;}
function ramGB(a){return toGB(nestedMeasure(a?.ram_memory,"installed_size"));}
function storageGB(a){const h=toGB(nestedMeasure(a?.hard_disk,"size"));return h!==null?h:toGB(nestedMeasure(a?.flash_memory,"installed_size"));}
function validGtin13(v){if(!/^\d{13}$/.test(v))return false;const d=[...v].map(Number);let s=0;for(let i=0;i<12;i++)s+=d[i]*(i%2===0?1:3);return ((10-(s%10))%10)===d[12];}
function pickBool(spec,want,label){
  if(!spec)throw new Error(`PTD_MISSING ${label}`);const allowed=rawValues(spec);
  if(allowed.some(v=>v===want))return want;
  const m=allowed.find(v=>String(v).toLowerCase()===String(want).toLowerCase());if(m!==undefined)return m;
  if(String(spec.type||"").toLowerCase()==="boolean")return want;
  throw new Error(`PTD_BOOLEAN_UNRESOLVED ${label}`);
}
function pickIdentifierType(schema){
  const allowed=vals(nestedSpec(schema,"externally_assigned_product_identifier","type"));
  const selected=allowed.find(v=>/^ean$/i.test(v))||allowed.find(v=>/ean/i.test(v))||allowed.find(v=>/^gtin$/i.test(v));
  if(!selected)throw new Error(`PTD_IDENTIFIER_TYPE_UNRESOLVED ${JSON.stringify(allowed.slice(0,20))}`);
  return {selected,allowed};
}
function setValue(a,k,v){
  if(Array.isArray(a[k])&&a[k][0]){a[k]=clone(a[k]);a[k][0].value=v;}
  else a[k]=[{marketplace_id:MARKETPLACE_ID,language_tag:"ja_JP",value:v}];
}
function replaceSize(rows,key,gb){
  const x=clone(rows||[]);if(!x.length)throw new Error(`MISSING_${key}`);
  if(key==="hard_disk"){
    if(!Array.isArray(x[0].size)||!x[0].size[0])throw new Error("HARD_DISK_SHAPE");
    x[0].size[0].value=gb;x[0].size[0].unit="GB";
  }else{
    if(!Array.isArray(x[0].installed_size)||!x[0].installed_size[0])throw new Error("FLASH_MEMORY_SHAPE");
    x[0].installed_size[0].value=gb;x[0].installed_size[0].unit="GB";
  }
  return x;
}
function stripImages(a){for(const k of Object.keys(a||{})){if(k==="main_product_image_locator"||/^other_product_image_locator_/i.test(k)||/^swatch_product_image_locator/i.test(k))delete a[k];}}
function stripOfferAndIdentity(a){
  for(const k of [
    "externally_assigned_product_identifier","merchant_suggested_asin","supplier_declared_has_product_identifier_exemption",
    "purchasable_offer","fulfillment_availability","list_price","minimum_seller_allowed_price","maximum_seller_allowed_price","merchant_shipping_group"
  ])delete a[k];
}
function relationRows(kind,relationship){
  const r={parentage_level:[{marketplace_id:MARKETPLACE_ID,value:kind}],variation_theme:[{name:THEME}]};
  if(kind==="child")r.child_parent_sku_relationship=[{marketplace_id:MARKETPLACE_ID,child_relationship_type:relationship,parent_sku:PARENT_SKU}];
  return r;
}
function attrPatch(attrs,key,value){return {op:Array.isArray(attrs?.[key])&&attrs[key].length?"replace":"add",path:`/attributes/${key}`,value};}
function child256Patches(attrs,relationship,exclusiveRows){
  const out=Object.entries(relationRows("child",relationship)).map(([k,v])=>attrPatch(attrs,k,v));
  out.push(attrPatch(attrs,"is_exclusive_product",clone(exclusiveRows)));return out;
}
function parentAttrs(source,exclusiveRows){
  const a=clone(source);stripOfferAndIdentity(a);stripImages(a);
  for(const k of ["condition_type","hard_disk","flash_memory","child_parent_sku_relationship","parentage_level","variation_theme"])delete a[k];
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ ノートン360付属 MTD整備済み");
  a.parentage_level=[{marketplace_id:MARKETPLACE_ID,value:"parent"}];
  a.variation_theme=[{name:THEME}];
  a.is_exclusive_product=clone(exclusiveRows);
  return a;
}
function child512Attrs(source,exclusiveRows,identifierType,relationship){
  const a=clone(source);stripOfferAndIdentity(a);stripImages(a);
  a.hard_disk=replaceSize(a.hard_disk,"hard_disk",512);
  a.flash_memory=replaceSize(a.flash_memory,"flash_memory",512);
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD512GB Win11 Pro ノートン・Office付");
  a.externally_assigned_product_identifier=[{marketplace_id:MARKETPLACE_ID,type:identifierType,value:GTIN}];
  a.is_exclusive_product=clone(exclusiveRows);
  Object.assign(a,relationRows("child",relationship));
  return a;
}
async function patchPreview(a,sku,patches){
  const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:PRODUCT_TYPE,patches}});
}
async function putPreview(a,sku,attrs){
  const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PUT",body:{productType:PRODUCT_TYPE,requirements:"LISTING",attributes:attrs}});
}
function sum(r){
  const issues=Array.isArray(r?.body?.issues)?r.body.issues:[];const errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR");const status=String(r?.body?.status||"").toUpperCase();
  return {httpStatus:r.http,responseOk:r.ok,status,submissionId:r?.body?.submissionId||"",issueCount:issues.length,errorCount:errors.length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],errors:errors.slice(0,12).map(i=>({code:String(i?.code||""),message:String(i?.message||"").slice(0,600),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(status)};
}
async function runPreflight(){
  if(!validGtin13(GTIN))throw new Error(`GTIN_CHECK_DIGIT_INVALID ${GTIN}`);
  const a=await token();
  const source=await getListing(a,SOURCE_SKU);if(!source.ok)throw new Error(`SOURCE_GET_${source.http}`);
  const ss=source.body?.summaries?.[0]||{},attrs=source.body?.attributes||{};
  if(String(source.body?.sku||"")!==SOURCE_SKU||String(ss.asin||"")!==SOURCE_ASIN||String(ss.productType||"")!==PRODUCT_TYPE)throw new Error("SOURCE_IDENTITY_DRIFT");
  if(ramGB(attrs)!==16||storageGB(attrs)!==256)throw new Error(`SOURCE_SPEC_DRIFT ram=${ramGB(attrs)} storage=${storageGB(attrs)}`);
  const sourceIssues=Array.isArray(source.body?.issues)?source.body.issues:[];
  if(sourceIssues.some(i=>String(i?.severity||"").toUpperCase()==="ERROR"))throw new Error("SOURCE_HAS_ERRORS");

  const parentFresh=await getListing(a,PARENT_SKU);if(parentFresh.ok)throw new Error("PARENT_SKU_ALREADY_EXISTS");if(parentFresh.http!==404)throw new Error(`PARENT_PREFLIGHT_HTTP_${parentFresh.http}`);
  const child512Fresh=await getListing(a,CHILD512_SKU);if(child512Fresh.ok)throw new Error("CHILD512_SKU_ALREADY_EXISTS");if(child512Fresh.http!==404)throw new Error(`CHILD512_PREFLIGHT_HTTP_${child512Fresh.http}`);

  const schema=await getSchema(a);
  if(!vals(nestedSpec(schema,"variation_theme","name")).includes(THEME))throw new Error(`PTD_THEME_MISSING_${THEME}`);
  const parentVals=vals(nestedSpec(schema,"parentage_level","value"));if(!parentVals.includes("parent")||!parentVals.includes("child"))throw new Error("PTD_PARENTAGE_MISSING");
  const relationship=vals(nestedSpec(schema,"child_parent_sku_relationship","child_relationship_type")).find(v=>/^variation$/i.test(v));if(!relationship)throw new Error("PTD_RELATIONSHIP_MISSING");
  const exclusive=pickBool(nestedSpec(schema,"is_exclusive_product","value"),false,"is_exclusive_product.value");
  const identifier=pickIdentifierType(schema);
  const exclusiveRows=[{marketplace_id:MARKETPLACE_ID,value:exclusive}];

  const pAttrs=parentAttrs(attrs,exclusiveRows);
  const c512Attrs=child512Attrs(attrs,exclusiveRows,identifier.selected,relationship);
  const child256P=child256Patches(attrs,relationship,exclusiveRows);

  const parent=sum(await putPreview(a,PARENT_SKU,pAttrs));
  const child256=sum(await patchPreview(a,SOURCE_SKU,child256P));
  const child512=sum(await putPreview(a,CHILD512_SKU,c512Attrs));
  const ready=parent.valid&&child256.valid&&child512.valid;
  return {
    ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,amazonPersistentWrites:0,externalChanges:0,status:ready?"PASS":"BLOCK",
    sourceAudit:{sku:SOURCE_SKU,asin:SOURCE_ASIN,title:String(ss.itemName||first(attrs.item_name)||""),ramGB:ramGB(attrs),storageGB:storageGB(attrs),issueCount:sourceIssues.length},
    newSkuGuards:{parentSku:PARENT_SKU,parentFreshHttp:parentFresh.http,child512Sku:CHILD512_SKU,child512FreshHttp:child512Fresh.http},
    identifier:{gtin:GTIN,checkDigitValid:true,type:identifier.selected,allowedTypes:identifier.allowed.slice(0,20)},
    schemaSelection:{variationTheme:THEME,relationship,isExclusiveProductValue:exclusive},
    noOfferDesign:{child512Removed:["purchasable_offer","fulfillment_availability","list_price","minimum_seller_allowed_price","maximum_seller_allowed_price","merchant_shipping_group"],parentNoOffer:true,child512InventoryWritePlanned:false,child512PriceWritePlanned:false},
    preview:{parent,child256,child512},
    readyForExplicitLiveApproval:ready,
    next:ready?"PASS. Prepare guarded LIVE route, but do not execute without explicit user LIVE approval.":"BLOCK. Inspect validation errors; no Amazon persistent write occurred."
  };
}
async function handler(req,res){
  try{
    const sec=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();if(!sec)return res.status(500).json({ok:false,readOnly:true,externalChanges:0,error:"secret missing"});
    if(String(req.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,readOnly:true,externalChanges:0,error:"Unauthorized"});
    if(req.body?.dryRun===false)throw new Error("LIVE_DISABLED_FINAL_PREFLIGHT_ONLY");
    return res.status(200).json(await runPreflight());
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,amazonPersistentWrites:0,externalChanges:0,error:err?.message||String(err)});}
}
express.application.listen=function s73FinalPreflightListen(...args){
  const exists=Boolean(this?._router?.stack?.some(l=>l?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);
  const server=originalListen.apply(this,args);
  if(!autoRunStarted){autoRunStarted=true;setTimeout(async()=>{try{console.log("S73_VARIATION_FINAL_PREFLIGHT_RESULT="+JSON.stringify(await runPreflight()));}catch(err){console.error("S73_VARIATION_FINAL_PREFLIGHT_ERROR="+(err?.message||String(err)));}},2500);}
  return server;
};
