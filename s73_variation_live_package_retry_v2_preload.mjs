import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION="2026-09-07-s73-variation-live-package-retry-v2.0.0";
const ROUTE="/amazon/listing/s73-variation-live-package-retry-v2";
const MARKETPLACE_ID="A1VC38T7YXB528";
const PRODUCT_TYPE="NOTEBOOK_COMPUTER";
const SOURCE_SKU="7X-725F-2ZML";
const SOURCE_ASIN="B0HGDBYRS8";
const CHILD512_SKU="s73-hs-i5-11g-16gb-ssd512";
const PARENT_SKU="s73-hs-i5-11g-16gb-storage-parent";
const GTIN="4595989934966";
const THEME="HARD_DISK_SIZE";
const PACKAGE={lengthCm:38.5,widthCm:27.5,heightCm:14,weightKg:1.9};
const originalListen=express.application.listen;
let once=false;
let consumed=false;

function j(t){try{return t?JSON.parse(t):{};}catch{return {rawText:String(t||"").slice(0,4000)};}}
function c(v){return JSON.parse(JSON.stringify(v));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function cfg(){
 const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
 const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
 const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
 if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID");
 if(marketplaceId!==MARKETPLACE_ID)throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);
 return {sellerId,marketplaceId,endpoint};
}
async function token(){
 const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:process.env.REFRESH_TOKEN,client_id:process.env.LWA_CLIENT_ID,client_secret:process.env.LWA_CLIENT_SECRET})});
 const x=j(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA_${r.status}`);return x.access_token;
}
async function req(url,a,opt={}){const r=await fetch(url,{method:opt.method||"GET",headers:{"x-amz-access-token":a,accept:"application/json",...(opt.body?{"content-type":"application/json"}:{})},...(opt.body?{body:JSON.stringify(opt.body)}:{})});return {http:r.status,ok:r.ok,body:j(await r.text())};}
async function listing(a,sku){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a);}
async function schema(a){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});const d=await req(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`,a);if(!d.ok)throw new Error(`PTD_${d.http}`);const u=String(d.body?.schema?.link?.resource||"");if(!u)throw new Error("PTD_SCHEMA_LINK_MISSING");const r=await fetch(u,{headers:{accept:"application/json"}});if(!r.ok)throw new Error(`PTD_SCHEMA_${r.status}`);return j(await r.text());}
function vals(spec){const out=[];(function w(n,d){if(!n||typeof n!=="object"||d>6)return;if(Array.isArray(n)){n.forEach(x=>w(x,d+1));return;}if(Array.isArray(n.enum))out.push(...n.enum.map(String));if(n.const!==undefined)out.push(String(n.const));for(const k of ["items","properties","oneOf","anyOf","allOf"])w(n[k],d+1);})(spec,0);return [...new Set(out)];}
function nested(s,n,k){return s?.properties?.[n]?.items?.properties?.[k]||null;}
function first(a){return Array.isArray(a)&&a[0]?a[0].value??null:null;}
function measure(rows,key){return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0][key])&&rows[0][key][0]?rows[0][key][0]:null;}
function gb(x){if(!x)return null;const v=Number(x.value);if(!Number.isFinite(v))return null;const u=String(x.unit||"GB").toUpperCase();return u==="TB"?v*1024:u==="MB"?v/1024:v;}
function ram(a){return gb(measure(a?.ram_memory,"installed_size"));}
function storage(a){return gb(measure(a?.hard_disk,"size"))??gb(measure(a?.flash_memory,"installed_size"));}
function validGtin(v){if(!/^\d{13}$/.test(v))return false;const d=[...v].map(Number);let s=0;for(let i=0;i<12;i++)s+=d[i]*(i%2?3:1);return ((10-s%10)%10)===d[12];}
function setVal(a,k,v){if(Array.isArray(a[k])&&a[k][0]){a[k]=c(a[k]);a[k][0].value=v;}else a[k]=[{marketplace_id:MARKETPLACE_ID,language_tag:"ja_JP",value:v}];}
function setStorage(rows,key,v){const x=c(rows||[]);if(!x[0])throw new Error(`MISSING_${key}`);if(key==="hard_disk"){if(!x[0].size?.[0])throw new Error("HARD_DISK_SHAPE");x[0].size[0].value=v;x[0].size[0].unit="GB";}else{if(!x[0].installed_size?.[0])throw new Error("FLASH_MEMORY_SHAPE");x[0].installed_size[0].value=v;x[0].installed_size[0].unit="GB";}return x;}
function stripImages(a){for(const k of Object.keys(a)){if(k==="main_product_image_locator"||/^other_product_image_locator_/i.test(k)||/^swatch_product_image_locator/i.test(k))delete a[k];}}
function rel(kind,relationship){const r={parentage_level:[{marketplace_id:MARKETPLACE_ID,value:kind}],variation_theme:[{name:THEME}]};if(kind==="child")r.child_parent_sku_relationship=[{marketplace_id:MARKETPLACE_ID,child_relationship_type:relationship,parent_sku:PARENT_SKU}];return r;}
function patch(attrs,k,v){return {op:Array.isArray(attrs?.[k])&&attrs[k].length?"replace":"add",path:`/attributes/${k}`,value:v};}
function parentAttrs(src,exclusive){const a=c(src);stripImages(a);for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin","supplier_declared_has_product_identifier_exemption","purchasable_offer","fulfillment_availability","condition_type","list_price","minimum_seller_allowed_price","maximum_seller_allowed_price","merchant_shipping_group","hard_disk","flash_memory","child_parent_sku_relationship","parentage_level","variation_theme"])delete a[k];setVal(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ ノートン360付属 MTD整備済み");a.parentage_level=[{marketplace_id:MARKETPLACE_ID,value:"parent"}];a.variation_theme=[{name:THEME}];a.is_exclusive_product=[{marketplace_id:MARKETPLACE_ID,value:exclusive}];return a;}
function child512Attrs(src,exclusive,idType,relationship){const a=c(src);stripImages(a);for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin","supplier_declared_has_product_identifier_exemption","purchasable_offer","fulfillment_availability","minimum_seller_allowed_price","maximum_seller_allowed_price"])delete a[k];a.hard_disk=setStorage(a.hard_disk,"hard_disk",512);a.flash_memory=setStorage(a.flash_memory,"flash_memory",512);setVal(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD512GB Win11 Pro ノートン・Office付");a.externally_assigned_product_identifier=[{marketplace_id:MARKETPLACE_ID,type:idType,value:GTIN}];a.is_exclusive_product=[{marketplace_id:MARKETPLACE_ID,value:exclusive}];Object.assign(a,rel("child",relationship));a.item_package_dimensions=[{marketplace_id:MARKETPLACE_ID,length:{value:PACKAGE.lengthCm,unit:"centimeters"},width:{value:PACKAGE.widthCm,unit:"centimeters"},height:{value:PACKAGE.heightCm,unit:"centimeters"}}];a.item_package_weight=[{marketplace_id:MARKETPLACE_ID,value:PACKAGE.weightKg,unit:"kilograms"}];return a;}
async function put(a,sku,attrs,preview){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});if(preview)q.set("mode","VALIDATION_PREVIEW");return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PUT",body:{productType:PRODUCT_TYPE,requirements:"LISTING",attributes:attrs}});}
async function patchReq(a,sku,patches,preview){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});if(preview)q.set("mode","VALIDATION_PREVIEW");return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:PRODUCT_TYPE,patches}});}
function sum(r){const issues=Array.isArray(r?.body?.issues)?r.body.issues:[];const errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR");const st=String(r?.body?.status||"").toUpperCase();return {httpStatus:r.http,status:st,errorCount:errors.length,issues:issues.slice(0,10),valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(st)};}
function relation(a){return {parentage:first(a?.parentage_level),parentSku:a?.child_parent_sku_relationship?.[0]?.parent_sku||null,relationship:a?.child_parent_sku_relationship?.[0]?.child_relationship_type||null,theme:a?.variation_theme?.[0]?.name||null};}
async function execute(){
 if(consumed)throw new Error("LIVE_ALREADY_CONSUMED_THIS_PROCESS");consumed=true;if(!validGtin(GTIN))throw new Error("GTIN_INVALID");
 const a=await token();const src=await listing(a,SOURCE_SKU);if(!src.ok)throw new Error(`SOURCE_GET_${src.http}`);const s=src.body?.summaries?.[0]||{},attrs=src.body?.attributes||{};
 if(String(src.body?.sku||"")!==SOURCE_SKU||String(s.asin||"")!==SOURCE_ASIN||String(s.productType||"")!==PRODUCT_TYPE)throw new Error("SOURCE_IDENTITY_DRIFT");if(ram(attrs)!==16||storage(attrs)!==256)throw new Error(`SOURCE_SPEC_DRIFT:${ram(attrs)}/${storage(attrs)}`);
 const pf=await listing(a,PARENT_SKU);if(pf.ok)throw new Error("PARENT_ALREADY_EXISTS_ABORT");if(pf.http!==404)throw new Error(`PARENT_PREFLIGHT_${pf.http}`);const cf=await listing(a,CHILD512_SKU);if(cf.ok)throw new Error("CHILD512_ALREADY_EXISTS_ABORT");if(cf.http!==404)throw new Error(`CHILD512_PREFLIGHT_${cf.http}`);
 const sc=await schema(a);if(!vals(nested(sc,"variation_theme","name")).includes(THEME))throw new Error("THEME_MISSING");const relationship=vals(nested(sc,"child_parent_sku_relationship","child_relationship_type")).find(v=>/^variation$/i.test(v));if(!relationship)throw new Error("RELATIONSHIP_MISSING");const exSpec=nested(sc,"is_exclusive_product","value");const exclusive=vals(exSpec).some(v=>v==="false")?false:false;const types=vals(nested(sc,"externally_assigned_product_identifier","type"));const idType=types.find(v=>/^ean$/i.test(v))||types.find(v=>/ean/i.test(v));if(!idType)throw new Error("EAN_TYPE_MISSING");
 const pAttrs=parentAttrs(attrs,exclusive),cAttrs=child512Attrs(attrs,exclusive,idType,relationship),c256=[...Object.entries(rel("child",relationship)).map(([k,v])=>patch(attrs,k,v)),patch(attrs,"is_exclusive_product",[{marketplace_id:MARKETPLACE_ID,value:exclusive}])];
 const previews={parent:sum(await put(a,PARENT_SKU,pAttrs,true)),child512:sum(await put(a,CHILD512_SKU,cAttrs,true)),child256:sum(await patchReq(a,SOURCE_SKU,c256,true))};
 if(!previews.parent.valid||!previews.child512.valid||!previews.child256.valid)return {ok:false,status:"BLOCK",moduleVersion:MODULE_VERSION,package:PACKAGE,previews,amazonPersistentWrites:0,externalChanges:0};
 const writes=[];const pLive=sum(await put(a,PARENT_SKU,pAttrs,false));writes.push({type:"PUT_PARENT",result:pLive});if(!pLive.valid)return {ok:false,status:"PARTIAL_OR_UNKNOWN",writes,amazonPersistentWrites:1,externalChanges:1,doNotRetryAutomatically:true};const cLive=sum(await put(a,CHILD512_SKU,cAttrs,false));writes.push({type:"PUT_CHILD512",result:cLive});if(!cLive.valid)return {ok:false,status:"PARTIAL_OR_UNKNOWN",writes,amazonPersistentWrites:2,externalChanges:2,doNotRetryAutomatically:true};const rLive=sum(await patchReq(a,SOURCE_SKU,c256,false));writes.push({type:"PATCH_CHILD256_RELATION",result:rLive});if(!rLive.valid)return {ok:false,status:"PARTIAL_OR_UNKNOWN",writes,amazonPersistentWrites:3,externalChanges:3,doNotRetryAutomatically:true};
 let verify=null;for(let i=1;i<=12;i++){const p=await listing(a,PARENT_SKU),c5=await listing(a,CHILD512_SKU),c2=await listing(a,SOURCE_SKU);const rp=relation(p.body?.attributes||{}),r5=relation(c5.body?.attributes||{}),r2=relation(c2.body?.attributes||{});verify={attempt:i,parent:{http:p.http,relation:rp},child512:{http:c5.http,asin:String(c5.body?.summaries?.[0]?.asin||""),storageGB:storage(c5.body?.attributes||{}),relation:r5},child256:{http:c2.http,asin:String(c2.body?.summaries?.[0]?.asin||""),storageGB:storage(c2.body?.attributes||{}),relation:r2}};if(p.ok&&rp.parentage==="parent"&&rp.theme===THEME&&c5.ok&&verify.child512.asin&&verify.child512.storageGB===512&&r5.parentSku===PARENT_SKU&&c2.ok&&verify.child256.asin===SOURCE_ASIN&&verify.child256.storageGB===256&&r2.parentSku===PARENT_SKU)break;if(i<12)await sleep(5000);}
 const ok=verify?.parent?.relation?.parentage==="parent"&&verify?.child512?.asin&&verify?.child512?.relation?.parentSku===PARENT_SKU&&verify?.child256?.asin===SOURCE_ASIN&&verify?.child256?.relation?.parentSku===PARENT_SKU;
 return {ok:Boolean(ok),status:ok?"PASS":"ACCEPTED_PENDING_VERIFICATION",moduleVersion:MODULE_VERSION,variationTheme:THEME,gtin:GTIN,package:PACKAGE,parentSku:PARENT_SKU,child512Sku:CHILD512_SKU,previews,writes,verification:verify,amazonPersistentWrites:3,inventoryWrites:0,sellingPriceWrites:0,b2bWrites:0,adsWrites:0,imageWrites:0,externalChanges:3,doNotRetryAutomatically:!ok};
}
async function handler(req,res){try{const sec=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();if(String(req.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,error:"Unauthorized"});if(req.body?.confirmLive!=="CONFIRM_S73_VARIATION_LIVE_PACKAGE_V2_20260907")return res.status(400).json({ok:false,error:"confirmation token mismatch"});return res.status(200).json(await execute());}catch(e){return res.status(400).json({ok:false,status:"BLOCK_OR_PARTIAL_UNKNOWN",error:e?.message||String(e),doNotRetryAutomatically:true});}}
express.application.listen=function(...args){const exists=Boolean(this?._router?.stack?.some(x=>x?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);const server=originalListen.apply(this,args);if(!once){once=true;setTimeout(()=>execute().then(x=>console.log("S73_VARIATION_LIVE_PACKAGE_V2_RESULT="+JSON.stringify(x))).catch(e=>console.error("S73_VARIATION_LIVE_PACKAGE_V2_ERROR="+(e?.message||String(e)))),3000);}return server;};
