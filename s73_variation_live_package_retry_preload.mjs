import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-07-s73-variation-live-package-retry-v1.0.0";
const ROUTE = "/amazon/listing/s73-variation-live-package-retry";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const SOURCE_SKU = "7X-725F-2ZML";
const SOURCE_ASIN = "B0HGDBYRS8";
const CHILD512_SKU = "s73-hs-i5-11g-16gb-ssd512";
const PARENT_SKU = "s73-hs-i5-11g-16gb-storage-parent";
const GTIN = "4595989934966";
const THEME = "HARD_DISK_SIZE";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 12;
const VERIFY_GAP_MS = 5000;
const PACKAGE_LENGTH_CM = 38.5;
const PACKAGE_WIDTH_CM = 27.5;
const PACKAGE_HEIGHT_CM = 14.0;
const PACKAGE_WEIGHT_KG = 1.9;
const originalListen = express.application.listen;
let autoRunStarted = false;
let liveConsumed = false;

function jparse(t){try{return t?JSON.parse(t):{};}catch{return {rawText:String(t||"").slice(0,4000)};}}
function clone(v){return JSON.parse(JSON.stringify(v));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
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
function rawValues(spec){const out=[];const seen=new Set();(function walk(n,d){if(!n||typeof n!=="object"||d>7)return;if(Array.isArray(n)){n.forEach(x=>walk(x,d+1));return;}if(Array.isArray(n.enum))for(const v of n.enum){const k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}if(n.const!==undefined){const v=n.const,k=typeof v+":"+JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}for(const k of ["items","properties","oneOf","anyOf","allOf"])walk(n[k],d+1);})(spec,0);return out;}
function nestedSpec(s,n,c){return s?.properties?.[n]?.items?.properties?.[c]||null;}
function vals(s){return rawValues(s).map(String);}
function first(rows){return Array.isArray(rows)&&rows[0]?rows[0].value??null:null;}
function nestedMeasure(rows,key){return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0][key])&&rows[0][key][0]?rows[0][key][0]:null;}
function toGB(row){if(!row)return null;const v=Number(row.value);if(!Number.isFinite(v))return null;const u=String(row.unit||"GB").toUpperCase();return u==="TB"?v*1024:u==="MB"?v/1024:v;}
function ramGB(a){return toGB(nestedMeasure(a?.ram_memory,"installed_size"));}
function storageGB(a){const h=toGB(nestedMeasure(a?.hard_disk,"size"));return h!==null?h:toGB(nestedMeasure(a?.flash_memory,"installed_size"));}
function validGtin13(v){if(!/^\d{13}$/.test(v))return false;const d=[...v].map(Number);let s=0;for(let i=0;i<12;i++)s+=d[i]*(i%2===0?1:3);return ((10-(s%10))%10)===d[12];}
function pickBool(spec,want,label){if(!spec)throw new Error(`PTD_MISSING ${label}`);const allowed=rawValues(spec);if(allowed.some(v=>v===want))return want;const m=allowed.find(v=>String(v).toLowerCase()===String(want).toLowerCase());if(m!==undefined)return m;if(String(spec.type||"").toLowerCase()==="boolean")return want;throw new Error(`PTD_BOOLEAN_UNRESOLVED ${label}`);}
function pickIdentifierType(schema){const allowed=vals(nestedSpec(schema,"externally_assigned_product_identifier","type"));const selected=allowed.find(v=>/^ean$/i.test(v))||allowed.find(v=>/ean/i.test(v))||allowed.find(v=>/^gtin$/i.test(v));if(!selected)throw new Error(`PTD_IDENTIFIER_TYPE_UNRESOLVED ${JSON.stringify(allowed.slice(0,20))}`);return {selected,allowed};}
function setValue(a,k,v){if(Array.isArray(a[k])&&a[k][0]){a[k]=clone(a[k]);a[k][0].value=v;}else a[k]=[{marketplace_id:MARKETPLACE_ID,language_tag:"ja_JP",value:v}];}
function replaceSize(rows,key,gb){const x=clone(rows||[]);if(!x.length)throw new Error(`MISSING_${key}`);if(key==="hard_disk"){if(!Array.isArray(x[0].size)||!x[0].size[0])throw new Error("HARD_DISK_SHAPE");x[0].size[0].value=gb;x[0].size[0].unit="GB";}else{if(!Array.isArray(x[0].installed_size)||!x[0].installed_size[0])throw new Error("FLASH_MEMORY_SHAPE");x[0].installed_size[0].value=gb;x[0].installed_size[0].unit="GB";}return x;}
function stripImages(a){for(const k of Object.keys(a||{})){if(k==="main_product_image_locator"||/^other_product_image_locator_/i.test(k)||/^swatch_product_image_locator/i.test(k))delete a[k];}}
function relationRows(kind,relationship){const r={parentage_level:[{marketplace_id:MARKETPLACE_ID,value:kind}],variation_theme:[{name:THEME}]};if(kind==="child")r.child_parent_sku_relationship=[{marketplace_id:MARKETPLACE_ID,child_relationship_type:relationship,parent_sku:PARENT_SKU}];return r;}
function attrPatch(attrs,key,value){return {op:Array.isArray(attrs?.[key])&&attrs[key].length?"replace":"add",path:`/attributes/${key}`,value};}
function child256Patches(attrs,relationship,exclusiveRows){const out=Object.entries(relationRows("child",relationship)).map(([k,v])=>attrPatch(attrs,k,v));out.push(attrPatch(attrs,"is_exclusive_product",clone(exclusiveRows)));return out;}
function parentAttrs(source,exclusiveRows){
  const a=clone(source);stripImages(a);
  for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin","supplier_declared_has_product_identifier_exemption","purchasable_offer","fulfillment_availability","condition_type","list_price","minimum_seller_allowed_price","maximum_seller_allowed_price","merchant_shipping_group","hard_disk","flash_memory","child_parent_sku_relationship","parentage_level","variation_theme"])delete a[k];
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ ノートン360付属 MTD整備済み");
  a.parentage_level=[{marketplace_id:MARKETPLACE_ID,value:"parent"}];a.variation_theme=[{name:THEME}];a.is_exclusive_product=clone(exclusiveRows);return a;
}
function setPackageFieldsFromSourceShape(a){
  if(!Array.isArray(a.item_package_dimensions)||!a.item_package_dimensions[0])throw new Error("SOURCE_PACKAGE_DIMENSIONS_MISSING");
  a.item_package_dimensions=clone(a.item_package_dimensions);
  const d=a.item_package_dimensions[0];
  const spec={length:PACKAGE_LENGTH_CM,width:PACKAGE_WIDTH_CM,height:PACKAGE_HEIGHT_CM};
  for(const [k,v] of Object.entries(spec)){
    if(!Array.isArray(d[k])||!d[k][0])throw new Error(`SOURCE_PACKAGE_DIMENSION_${k.toUpperCase()}_SHAPE_MISSING`);
    d[k][0].value=v;d[k][0].unit="centimeters";
  }
  if(!Array.isArray(a.item_package_weight)||!a.item_package_weight[0])throw new Error("SOURCE_PACKAGE_WEIGHT_MISSING");
  a.item_package_weight=clone(a.item_package_weight);
  a.item_package_weight[0].value=PACKAGE_WEIGHT_KG;
  a.item_package_weight[0].unit="kilograms";
}
function child512Attrs(source,exclusiveRows,identifierType,relationship){
  const a=clone(source);stripImages(a);
  for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin","supplier_declared_has_product_identifier_exemption","purchasable_offer","fulfillment_availability","minimum_seller_allowed_price","maximum_seller_allowed_price"])delete a[k];
  a.hard_disk=replaceSize(a.hard_disk,"hard_disk",512);a.flash_memory=replaceSize(a.flash_memory,"flash_memory",512);
  setValue(a,"item_name","【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD512GB Win11 Pro ノートン・Office付");
  a.externally_assigned_product_identifier=[{marketplace_id:MARKETPLACE_ID,type:identifierType,value:GTIN}];
  a.is_exclusive_product=clone(exclusiveRows);Object.assign(a,relationRows("child",relationship));setPackageFieldsFromSourceShape(a);return a;
}
async function patchListing(a,sku,patches,preview){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});if(preview)q.set("mode","VALIDATION_PREVIEW");return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:PRODUCT_TYPE,patches}});}
async function putListing(a,sku,attrs,preview){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});if(preview)q.set("mode","VALIDATION_PREVIEW");return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PUT",body:{productType:PRODUCT_TYPE,requirements:"LISTING",attributes:attrs}});}
function sum(r){const issues=Array.isArray(r?.body?.issues)?r.body.issues:[];const errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR");const status=String(r?.body?.status||"").toUpperCase();return {httpStatus:r.http,responseOk:r.ok,status,submissionId:r?.body?.submissionId||"",issueCount:issues.length,errorCount:errors.length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],errors:errors.slice(0,12).map(i=>({code:String(i?.code||""),message:String(i?.message||"").slice(0,600),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(status)};}
function relationOf(attrs){return {parentageLevel:first(attrs?.parentage_level),parentSku:attrs?.child_parent_sku_relationship?.[0]?.parent_sku||null,relationship:attrs?.child_parent_sku_relationship?.[0]?.child_relationship_type||null,theme:attrs?.variation_theme?.[0]?.name||null};}
async function executeLive(){
  if(liveConsumed)throw new Error("LIVE_ALREADY_CONSUMED_THIS_PROCESS");liveConsumed=true;
  if(!validGtin13(GTIN))throw new Error("GTIN_CHECK_DIGIT_INVALID");
  const a=await token();
  const source=await getListing(a,SOURCE_SKU);if(!source.ok)throw new Error(`SOURCE_GET_${source.http}`);
  const ss=source.body?.summaries?.[0]||{},attrs=source.body?.attributes||{},srcIssues=Array.isArray(source.body?.issues)?source.body.issues:[];
  if(String(source.body?.sku||"")!==SOURCE_SKU||String(ss.asin||"")!==SOURCE_ASIN||String(ss.productType||"")!==PRODUCT_TYPE)throw new Error("SOURCE_IDENTITY_DRIFT");
  if(ramGB(attrs)!==16||storageGB(attrs)!==256)throw new Error(`SOURCE_SPEC_DRIFT ram=${ramGB(attrs)} storage=${storageGB(attrs)}`);
  if(srcIssues.some(i=>String(i?.severity||"").toUpperCase()==="ERROR"))throw new Error("SOURCE_HAS_ERRORS");
  const pFresh=await getListing(a,PARENT_SKU);if(pFresh.ok)throw new Error("PARENT_SKU_ALREADY_EXISTS_ABORT");if(pFresh.http!==404)throw new Error(`PARENT_PREFLIGHT_HTTP_${pFresh.http}`);
  const cFresh=await getListing(a,CHILD512_SKU);if(cFresh.ok)throw new Error("CHILD512_SKU_ALREADY_EXISTS_ABORT");if(cFresh.http!==404)throw new Error(`CHILD512_PREFLIGHT_HTTP_${cFresh.http}`);
  const schema=await getSchema(a);if(!vals(nestedSpec(schema,"variation_theme","name")).includes(THEME))throw new Error("PTD_THEME_MISSING");
  const relationship=vals(nestedSpec(schema,"child_parent_sku_relationship","child_relationship_type")).find(v=>/^variation$/i.test(v));if(!relationship)throw new Error("PTD_RELATIONSHIP_MISSING");
  const exclusive=pickBool(nestedSpec(schema,"is_exclusive_product","value"),false,"is_exclusive_product.value");const identifier=pickIdentifierType(schema);const exclusiveRows=[{marketplace_id:MARKETPLACE_ID,value:exclusive}];
  const pAttrs=parentAttrs(attrs,exclusiveRows),cAttrs=child512Attrs(attrs,exclusiveRows,identifier.selected,relationship),c256Patches=child256Patches(attrs,relationship,exclusiveRows);
  const previews={parent:sum(await putListing(a,PARENT_SKU,pAttrs,true)),child512:sum(await putListing(a,CHILD512_SKU,cAttrs,true)),child256:sum(await patchListing(a,SOURCE_SKU,c256Patches,true))};
  if(!previews.parent.valid||!previews.child512.valid||!previews.child256.valid)return {ok:false,status:"BLOCK",moduleVersion:MODULE_VERSION,package:{lengthCm:PACKAGE_LENGTH_CM,widthCm:PACKAGE_WIDTH_CM,heightCm:PACKAGE_HEIGHT_CM,weightKg:PACKAGE_WEIGHT_KG},previews,amazonPersistentWrites:0,externalChanges:0,note:"Fresh validation preview failed. No live write sent."};
  const writes=[];
  const parentLive=sum(await putListing(a,PARENT_SKU,pAttrs,false));writes.push({type:"PUT_PARENT",sku:PARENT_SKU,result:parentLive});if(!parentLive.valid)return {ok:false,status:"PARTIAL_OR_UNKNOWN",previews,writes,amazonPersistentWrites:1,externalChanges:1,doNotRetryAutomatically:true};
  const child512Live=sum(await putListing(a,CHILD512_SKU,cAttrs,false));writes.push({type:"PUT_CHILD512",sku:CHILD512_SKU,result:child512Live});if(!child512Live.valid)return {ok:false,status:"PARTIAL_OR_UNKNOWN",previews,writes,amazonPersistentWrites:2,externalChanges:2,doNotRetryAutomatically:true};
  const child256Live=sum(await patchListing(a,SOURCE_SKU,c256Patches,false));writes.push({type:"PATCH_CHILD256_RELATION",sku:SOURCE_SKU,result:child256Live});if(!child256Live.valid)return {ok:false,status:"PARTIAL_OR_UNKNOWN",previews,writes,amazonPersistentWrites:3,externalChanges:3,doNotRetryAutomatically:true};
  let verify=null;
  for(let i=1;i<=VERIFY_ATTEMPTS;i++){
    const p=await getListing(a,PARENT_SKU),c512=await getListing(a,CHILD512_SKU),c256=await getListing(a,SOURCE_SKU);
    const pa=p.body?.attributes||{},a512=c512.body?.attributes||{},a256=c256.body?.attributes||{};
    const asin512=String(c512.body?.summaries?.[0]?.asin||"");const r512=relationOf(a512),r256=relationOf(a256),rp=relationOf(pa);
    const pOk=p.ok&&rp.parentageLevel==="parent"&&rp.theme===THEME;
    const c512Ok=c512.ok&&asin512&&storageGB(a512)===512&&r512.parentageLevel==="child"&&r512.parentSku===PARENT_SKU&&String(r512.relationship).toLowerCase()==="variation"&&r512.theme===THEME;
    const c256Ok=c256.ok&&String(c256.body?.summaries?.[0]?.asin||"")===SOURCE_ASIN&&storageGB(a256)===256&&r256.parentageLevel==="child"&&r256.parentSku===PARENT_SKU&&String(r256.relationship).toLowerCase()==="variation"&&r256.theme===THEME;
    verify={attempt:i,parent:{http:p.http,ok:pOk,relation:rp},child512:{http:c512.http,ok:c512Ok,asin:asin512,storageGB:storageGB(a512),relation:r512,issueCount:Array.isArray(c512.body?.issues)?c512.body.issues.length:null},child256:{http:c256.http,ok:c256Ok,asin:String(c256.body?.summaries?.[0]?.asin||""),storageGB:storageGB(a256),relation:r256,issueCount:Array.isArray(c256.body?.issues)?c256.body.issues.length:null}};
    if(pOk&&c512Ok&&c256Ok)break;if(i<VERIFY_ATTEMPTS)await sleep(VERIFY_GAP_MS);
  }
  const verified=Boolean(verify?.parent?.ok&&verify?.child512?.ok&&verify?.child256?.ok);
  return {ok:verified,status:verified?"PASS":"ACCEPTED_PENDING_VERIFICATION",moduleVersion:MODULE_VERSION,variationTheme:THEME,gtin:GTIN,package:{lengthCm:PACKAGE_LENGTH_CM,widthCm:PACKAGE_WIDTH_CM,heightCm:PACKAGE_HEIGHT_CM,weightKg:PACKAGE_WEIGHT_KG},sourceSku:SOURCE_SKU,sourceAsin:SOURCE_ASIN,parentSku:PARENT_SKU,child512Sku:CHILD512_SKU,previews,writes,verification:verify,amazonPersistentWrites:3,inventoryWrites:0,sellingPriceWrites:0,b2bWrites:0,adsWrites:0,imageWrites:0,externalChanges:3,doNotRetryAutomatically:!verified,note:verified?"S73 parent + 256/512 children created/linked and Fresh Listings GET verified.":"All three approved writes were sent once; verification still pending. Do not retry automatically."};
}
async function handler(req,res){try{const sec=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();if(!sec)return res.status(500).json({ok:false,error:"secret missing"});if(String(req.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,error:"Unauthorized"});if(req.body?.confirmLive!=="CONFIRM_S73_VARIATION_LIVE_PACKAGE_20260907")return res.status(400).json({ok:false,error:"confirmation token mismatch"});return res.status(200).json(await executeLive());}catch(err){return res.status(400).json({ok:false,status:"BLOCK_OR_PARTIAL_UNKNOWN",error:err?.message||String(err),doNotRetryAutomatically:true});}}
express.application.listen=function s73VariationPackageRetryListen(...args){const exists=Boolean(this?._router?.stack?.some(l=>l?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);const server=originalListen.apply(this,args);if(!autoRunStarted){autoRunStarted=true;setTimeout(async()=>{try{console.log("S73_VARIATION_LIVE_PACKAGE_RETRY_RESULT="+JSON.stringify(await executeLive()));}catch(err){console.error("S73_VARIATION_LIVE_PACKAGE_RETRY_ERROR="+(err?.message||String(err)));}},3200);}return server;};
