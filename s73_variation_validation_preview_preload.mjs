import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-07-s73-variation-validation-preview-v1.0.0";
const ROUTE = "/amazon/listing/s73-variation-validation-preview";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const G = Object.freeze({
  sourceSku: "7X-725F-2ZML",
  sourceAsin: "B0HGDBYRS8",
  child512Sku: "s73-hs-i5-11g-16gb-ssd512",
  parentSku: "s73-hs-i5-11g-16gb-storage-parent",
  productType: "NOTEBOOK_COMPUTER",
  sourceGB: 256,
  targetGB: 512,
});

function jparse(t){try{return t?JSON.parse(t):{};}catch{return {rawText:String(t||"").slice(0,3000)};}}
function clone(v){return JSON.parse(JSON.stringify(v));}
function secret(){return String(process.env.AMAZON_STOCK_API_SECRET||"").trim();}
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
async function listing(a){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  const r=await req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(G.sourceSku)}?${q}`,a);
  if(!r.ok)throw new Error(`source listing GET ${r.http}`);return r.body;
}
async function schema(a){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});
  const d=await req(`${endpoint}/definitions/2020-09-01/productTypes/${G.productType}?${q}`,a);if(!d.ok)throw new Error(`PTD GET ${d.http}`);
  const u=String(d.body?.schema?.link?.resource||"");if(!u)throw new Error("PTD schema link missing");
  const r=await ft(u,{headers:{accept:"application/json"}});const x=jparse(await r.text());if(!r.ok)throw new Error(`PTD schema fetch ${r.status}`);return x;
}
function rawValues(spec){
  const out=[];const seen=new Set();
  (function walk(n,d){
    if(!n||typeof n!=="object"||d>6)return;
    if(Array.isArray(n)){n.forEach(x=>walk(x,d+1));return;}
    if(Array.isArray(n.enum))n.enum.forEach(v=>{const k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}});
    if(n.const!==undefined){const v=n.const;const k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}
    ["items","properties","oneOf","anyOf","allOf"].forEach(k=>walk(n[k],d+1));
  })(spec,0);
  return out;
}
function values(spec){return rawValues(spec).map(v=>String(v));}
function prop(s,name){return s?.properties?.[name]||null;}
function nestedProp(s,name,child){return prop(s,name)?.items?.properties?.[child]||null;}
function pickEnum(arr,re,label){const x=arr.filter(v=>re.test(v));if(x.length!==1)throw new Error(`SCHEMA_AMBIGUOUS ${label}=${JSON.stringify(arr)}`);return x[0];}
function exclusiveSelection(s){
  const spec=nestedProp(s,"is_exclusive_product","value");if(!spec)throw new Error("SCHEMA_MISSING is_exclusive_product.value");
  const allowed=rawValues(spec);let value;
  if(allowed.some(v=>v===false))value=false;
  else if(allowed.some(v=>String(v).toLowerCase()==="false"))value=allowed.find(v=>String(v).toLowerCase()==="false");
  else if(String(spec.type||"").toLowerCase()==="boolean")value=false;
  else throw new Error(`SCHEMA_NO_FALSE is_exclusive_product=${JSON.stringify(allowed)}`);
  return {rows:[{marketplace_id:MARKETPLACE_ID,value}],value,valueType:typeof value,allowedValues:allowed.slice(0,10),schemaType:String(spec.type||"")};
}
function first(rows,key="value"){return Array.isArray(rows)&&rows[0]?rows[0]?.[key]??null:null;}
function assertSource(x){
  const s=x?.summaries?.[0]||{};const a=x?.attributes||{};
  if(String(x?.sku||"")!==G.sourceSku)throw new Error("source SKU mismatch");
  if(String(s.asin||"")!==G.sourceAsin)throw new Error("source ASIN mismatch");
  if(String(s.productType||"")!==G.productType)throw new Error("source productType mismatch");
  const title=String(s.itemName||a?.item_name?.[0]?.value||"");
  for(const t of ["S73/HS","1135G7","16GB","256"]){if(!title.toUpperCase().includes(t.toUpperCase()))throw new Error(`source title token missing ${t}`);}
  const hardDisk=Number(a?.hard_disk?.[0]?.size?.[0]?.value);
  const flash=Number(a?.flash_memory?.[0]?.installed_size?.[0]?.value);
  const ram=Number(a?.ram_memory?.[0]?.installed_size?.[0]?.value);
  if(hardDisk!==G.sourceGB)throw new Error(`source hard_disk expected=${G.sourceGB} actual=${hardDisk}`);
  if(flash!==G.sourceGB)throw new Error(`source flash_memory expected=${G.sourceGB} actual=${flash}`);
  if(ram!==16)throw new Error(`source ram expected=16 actual=${ram}`);
  return {
    attributes:a,
    audit:{sku:G.sourceSku,asin:G.sourceAsin,title,hardDiskGB:hardDisk,flashMemoryGB:flash,ramGB:ram,modelName:first(a.model_name),cpuFamily:a?.cpu_model?.[0]?.family?.[0]?.value||null,cpuModel:a?.cpu_model?.[0]?.model_number?.[0]?.value||null,issueCount:Array.isArray(x?.issues)?x.issues.length:0}
  };
}
function relationRows(kind,parentage,relationship,theme){
  const base={parentage_level:[{marketplace_id:MARKETPLACE_ID,value:kind}],variation_theme:[{name:theme}]};
  if(kind===parentage.child)base.child_parent_sku_relationship=[{marketplace_id:MARKETPLACE_ID,child_relationship_type:relationship,parent_sku:G.parentSku}];
  return base;
}
function replaceSizeRows(rows,field,newGB){
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
function setValue(attrs,name,value){if(!Array.isArray(attrs[name])||!attrs[name][0])throw new Error(`missing ${name}`);attrs[name]=clone(attrs[name]);attrs[name][0].value=value;}
function stripIdentity(attrs){for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin"])delete attrs[k];}
function stripOfferForParent(attrs){for(const k of ["purchasable_offer","condition_type","list_price","fulfillment_availability"])delete attrs[k];}
function stripImages(attrs){for(const k of Object.keys(attrs)){if(k==="main_product_image_locator"||/^other_product_image_locator_/i.test(k))delete attrs[k];}}
function buildParent(src,rel,exclusiveRows){
  const a=clone(src);stripIdentity(a);stripOfferForParent(a);stripImages(a);delete a.hard_disk;delete a.flash_memory;
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み");
  a.is_exclusive_product=clone(exclusiveRows);a.parentage_level=rel.parentage_level;a.variation_theme=rel.variation_theme;delete a.child_parent_sku_relationship;
  return a;
}
function build512(src,rel,exclusiveRows){
  const a=clone(src);stripIdentity(a);stripImages(a);
  a.hard_disk=replaceSizeRows(a.hard_disk,"hard_disk",G.targetGB);
  a.flash_memory=replaceSizeRows(a.flash_memory,"flash_memory",G.targetGB);
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD512GB Win11 Pro ノートン・Office付");
  a.is_exclusive_product=clone(exclusiveRows);Object.assign(a,rel);return a;
}
function child256Patches(rel,exclusiveRows){
  const patches=Object.entries(rel).map(([k,v])=>({op:"add",path:`/attributes/${k}`,value:v}));
  patches.push({op:"add",path:"/attributes/is_exclusive_product",value:clone(exclusiveRows)});
  return patches;
}
async function patchPreview(a,sku,patches){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:G.productType,patches}});
}
async function putPreview(a,sku,attrs){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PUT",body:{productType:G.productType,requirements:"LISTING",attributes:attrs}});
}
function sum(r){
  const issues=Array.isArray(r?.body?.issues)?r.body.issues:[];
  const errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR");
  const status=String(r?.body?.status||"").toUpperCase();
  return {httpStatus:r.http,responseOk:r.ok,status,issueCount:issues.length,errorCount:errors.length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],errors:errors.slice(0,8).map(i=>({code:String(i?.code||""),message:String(i?.message||"").slice(0,400),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(status)};
}
function storageThemes(all){
  const exact=new Set(all.filter(v=>String(v).split("/").includes("HARD_DISK_SIZE")));
  const preferred=["HARD_DISK_SIZE","HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE","DISPLAY_SIZE/HARD_DISK_SIZE","COMPUTER_MEMORY_SIZE/HARD_DISK_SIZE","GRAPHICS_COPROCESSOR/HARD_DISK_SIZE","DISPLAY_SIZE/RAM_MEMORY_INSTALLED_SIZE/HARD_DISK_SIZE","HARD_DISK_SIZE/PROCESSOR_DESCRIPTION/RAM_MEMORY_INSTALLED_SIZE"];
  const out=[];for(const p of preferred){if(exact.has(p)){out.push(p);exact.delete(p);}}
  const rest=[...exact].sort((a,b)=>a.split("/").length-b.split("/").length||a.localeCompare(b));
  return [...out,...rest].slice(0,12);
}
async function handler(req0,res){
  try{
    const sec=secret();
    if(!sec)return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,error:"secret missing"});
    if(String(req0.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,error:"Unauthorized"});
    if(req0.body?.dryRun===false)throw new Error("LIVE disabled; validation preview only");
    if(String(req0.body?.sourceSku||G.sourceSku)!==G.sourceSku||String(req0.body?.targetChildSku||G.child512Sku)!==G.child512Sku)throw new Error("GUARD_BLOCKED unexpected SKU");

    const accessToken=await token();
    const src=assertSource(await listing(accessToken));
    const s=await schema(accessToken);
    const exclusive=exclusiveSelection(s);
    const parentVals=values(nestedProp(s,"parentage_level","value"));
    const relVals=values(nestedProp(s,"child_parent_sku_relationship","child_relationship_type"));
    const themeVals=values(nestedProp(s,"variation_theme","name"));
    const parentValue=pickEnum(parentVals,/^parent$/i,"parentage parent");
    const childValue=pickEnum(parentVals,/^child$/i,"parentage child");
    const relationshipValue=pickEnum(relVals,/variation/i,"child_relationship_type");
    const parentage={parent:parentValue,child:childValue};

    const candidates=storageThemes(themeVals);
    if(!candidates.length)throw new Error("NO_HARD_DISK_SIZE_VARIATION_THEME");
    const probes=[];let selected="";
    for(const theme of candidates){
      const childRel=relationRows(childValue,parentage,relationshipValue,theme);
      const p=sum(await patchPreview(accessToken,G.sourceSku,child256Patches(childRel,exclusive.rows)));
      probes.push({theme,valid:p.valid,httpStatus:p.httpStatus,errorCount:p.errorCount,issueCodes:p.issueCodes,errors:p.errors});
      if(p.valid){selected=theme;break;}
    }
    if(!selected){
      return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,status:"BLOCK",sourceAudit:src.audit,reason:"NO_VALID_STORAGE_THEME_IN_PROBE_SET",schemaSelection:{parent:parentValue,child:childValue,relationship:relationshipValue,candidateCount:candidates.length,candidates},themeProbes:probes,readyForLiveDesign:false,next:"STOP. Review preview errors. No Amazon mutation occurred."});
    }

    const parentRel=relationRows(parentValue,parentage,relationshipValue,selected);
    const childRel=relationRows(childValue,parentage,relationshipValue,selected);
    const child256=sum(await patchPreview(accessToken,G.sourceSku,child256Patches(childRel,exclusive.rows)));
    const parent=sum(await putPreview(accessToken,G.parentSku,buildParent(src.attributes,parentRel,exclusive.rows)));
    const child512=sum(await putPreview(accessToken,G.child512Sku,build512(src.attributes,childRel,exclusive.rows)));
    const ready=child256.valid&&parent.valid&&child512.valid;

    return res.status(200).json({
      ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,
      status:ready?"PASS":"BLOCK",
      guards:{sourceSku:G.sourceSku,sourceAsin:G.sourceAsin,parentSku:G.parentSku,child512Sku:G.child512Sku,productType:G.productType,sourceGB:G.sourceGB,targetGB:G.targetGB},
      sourceAudit:src.audit,
      schemaSelection:{parent:parentValue,child:childValue,relationship:relationshipValue,selectedTheme:selected,storageThemeCandidateCount:candidates.length,candidates},
      exclusiveProduct:{selectedValue:exclusive.value,selectedValueType:exclusive.valueType,schemaType:exclusive.schemaType,allowedValues:exclusive.allowedValues},
      themeProbes:probes,
      preview:{parent,child256,child512},
      readyForLiveDesign:ready,
      next:ready?"Prepare a separately guarded LIVE route only after explicit user approval. Do not copy price/inventory decisions into LIVE without separate confirmation.":"STOP. Inspect validation errors; no live mutation."
    });
  }catch(err){
    return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,error:err?.message||String(err)});
  }
}

express.application.listen=function s73VariationValidationPreviewListen(...args){
  const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));
  if(!exists)this.post(ROUTE,handler);
  return originalListen.apply(this,args);
};
