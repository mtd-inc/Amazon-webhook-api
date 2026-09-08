import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-08-g83-replacement-fresh-audit-v1.0.0";
const ROUTE = "/amazon/listing/g83-replacement-fresh-audit";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const PARENT_SKU = "g83-hs-i5-11g-variation-parent";
const EXPECTED_PARENT_ASIN = "B0HHYNVYD5";
const REQUEST_TIMEOUT_MS = 25000;
const originalListen = express.application.listen;
let autoRunStarted = false;

const CHILDREN = Object.freeze([
  { sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", ramGB: 8, storageGB: 256, role: "REPLACEMENT_TARGET" },
  { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", ramGB: 8, storageGB: 512, role: "HEALTHY_CANONICAL" },
  { sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", ramGB: 8, storageGB: 1024, role: "REPLACEMENT_TARGET" },
  { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", ramGB: 16, storageGB: 256, role: "HEALTHY" },
  { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", ramGB: 16, storageGB: 512, role: "HEALTHY" },
  { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", ramGB: 16, storageGB: 1024, role: "HEALTHY" }
]);

const SELECTED_EXACT_KEYS = new Set([
  "item_name","brand","manufacturer","manufacturer_contact_information","model_name","model_number",
  "bullet_point","product_description","generic_keyword","search_terms","condition_type","included_components",
  "operating_system","processor_description","processor_model_number","processor_speed","processor_count",
  "ram_memory","computer_memory_type","hard_disk","flash_memory","graphics_description","graphics_coprocessor",
  "display","display_size","display_type","resolution","screen_resolution","item_weight","item_dimensions",
  "item_package_dimensions","item_package_weight","warranty_description","externally_assigned_product_identifier",
  "merchant_suggested_asin","is_exclusive_product","parentage_level","child_parent_sku_relationship","variation_theme"
]);

function jsonParse(text){try{return text?JSON.parse(text):{};}catch{return {rawText:String(text||"").slice(0,4000)};}}
function config(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId)throw new Error("Missing env: SPAPI_SELLER_ID");
  if(marketplaceId!==MARKETPLACE_ID)throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function ft(url,opt={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);try{return await fetch(url,{...opt,signal:c.signal});}finally{clearTimeout(t);}}
async function accessToken(){
  const clientId=process.env.LWA_CLIENT_ID,clientSecret=process.env.LWA_CLIENT_SECRET,refreshToken=process.env.REFRESH_TOKEN;
  if(!clientId||!clientSecret||!refreshToken)throw new Error("Missing LWA env");
  const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
  const x=jsonParse(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA token error ${r.status}`);return x.access_token;
}
async function getJson(url,token){const r=await ft(url,{headers:{"x-amz-access-token":token,accept:"application/json"}});return {http:r.status,ok:r.ok,body:jsonParse(await r.text())};}
async function listingGet(token,sku){const {sellerId,marketplaceId,endpoint}=config();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});return getJson(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,token);}
async function catalogGet(token,asin){const {marketplaceId,endpoint}=config();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"attributes,images,productTypes,relationships,summaries"});return getJson(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`,token);}
async function ptdGet(token){const {sellerId,marketplaceId,endpoint}=config();const q=new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});const d=await getJson(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`,token);if(!d.ok)throw new Error(`PTD GET ${d.http}`);const u=String(d.body?.schema?.link?.resource||"");if(!u)throw new Error("PTD schema link missing");const r=await ft(u,{headers:{accept:"application/json"}});const schema=jsonParse(await r.text());if(!r.ok)throw new Error(`PTD schema fetch ${r.status}`);return schema;}
function first(rows,key="value"){return Array.isArray(rows)&&rows[0]?rows[0]?.[key]??null:null;}
function nested(rows,key){return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0]?.[key])&&rows[0][key][0]?rows[0][key][0]?.value??null:null;}
function relation(attrs){return {parentageLevel:first(attrs?.parentage_level),parentSku:first(attrs?.child_parent_sku_relationship,"parent_sku")||null,childRelationshipType:first(attrs?.child_parent_sku_relationship,"child_relationship_type")||null,variationTheme:first(attrs?.variation_theme,"name")||null};}
function spec(attrs){return {ramGB:Number(nested(attrs?.ram_memory,"installed_size")??NaN),hardDiskGB:Number(nested(attrs?.hard_disk,"size")??NaN),flashMemoryGB:Number(nested(attrs?.flash_memory,"installed_size")??NaN)};}
function imageAttrs(attrs){const out={};for(const [k,v] of Object.entries(attrs||{})){if(k==="main_product_image_locator"||/^other_product_image_locator_/i.test(k)||/^swatch_product_image_locator/i.test(k))out[k]=v;}return out;}
function selectedAttrs(attrs){const out={};for(const [k,v] of Object.entries(attrs||{})){if(SELECTED_EXACT_KEYS.has(k)||/brand|manufacturer|model|processor|cpu|ram|memory|hard_disk|flash|office|norton|warranty|keyword|description|bullet|image_locator|included_component|operating_system/i.test(k))out[k]=v;}return out;}
function scanStrings(value,terms=["TOSHIBA","東芝"]){const text=JSON.stringify(value??{});const hits={};let total=0;for(const term of terms){const re=new RegExp(term,"gi");const m=text.match(re)||[];hits[term]=m.length;total+=m.length;}return {total,hits};}
function collectAsinPaths(node){const out=[];(function walk(v,path,d){if(d>12||v==null)return;if(typeof v==="string"){const s=v.trim().toUpperCase();if(/^[A-Z0-9]{10}$/.test(s))out.push({asin:s,path});return;}if(Array.isArray(v)){v.forEach((x,i)=>walk(x,`${path}[${i}]`,d+1));return;}if(typeof v==="object")for(const [k,x] of Object.entries(v))walk(x,path?`${path}.${k}`:k,d+1);})(node,"relationships",0);return out;}
function ptdSummary(schema){const themes=[];(function walk(n,d){if(!n||typeof n!=="object"||d>8)return;if(Array.isArray(n)){n.forEach(x=>walk(x,d+1));return;}if(Array.isArray(n.enum))for(const v of n.enum){if(typeof v==="string"&&/HARD_DISK_SIZE|RAM_MEMORY_INSTALLED_SIZE/i.test(v))themes.push(v);}for(const k of ["items","properties","oneOf","anyOf","allOf"])walk(n[k],d+1);})(schema,0);return {topLevelRequired:Array.isArray(schema?.required)?schema.required:[],variationThemes:[...new Set(themes)].sort(),expectedThemePresent:[...new Set(themes)].includes("HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE")};}
function listingSnapshot(plan,r){
  if(!r.ok)return {...plan,exists:false,httpStatus:r.http,error:r.body};
  const b=r.body||{},s=Array.isArray(b.summaries)?b.summaries[0]||{}:{},a=b.attributes||{},issues=Array.isArray(b.issues)?b.issues:[];
  return {...plan,exists:true,httpStatus:r.http,actualAsin:String(s.asin||""),productType:String(s.productType||""),title:String(s.itemName||first(a.item_name)||""),statuses:Array.isArray(s.status)?s.status:[],relation:relation(a),spec:spec(a),conditionType:first(a.condition_type),issueCount:issues.length,errorCount:issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR").length,issues:issues.map(i=>({code:String(i?.code||""),severity:String(i?.severity||""),message:String(i?.message||"").slice(0,500),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),attributeKeys:Object.keys(a).sort(),selectedAttributes:selectedAttrs(a),images:imageAttrs(a),contentTrademarkScan:scanStrings({selectedAttributes:selectedAttrs(a),images:imageAttrs(a)})};
}
async function runAudit(){
  const token=await accessToken();
  const schema=await ptdGet(token);
  const parentR=await listingGet(token,PARENT_SKU);
  const parent=listingSnapshot({sku:PARENT_SKU,asin:EXPECTED_PARENT_ASIN,role:"PARENT"},parentR);
  let parentCatalog=null;
  if(parent.exists&&parent.actualAsin){const cr=await catalogGet(token,parent.actualAsin);parentCatalog={httpStatus:cr.http,ok:cr.ok,asin:cr.body?.asin||parent.actualAsin,relationshipAsins:cr.ok?[...new Set(collectAsinPaths(cr.body?.relationships||[]).map(x=>x.asin))]:[],relationships:cr.ok?cr.body?.relationships||[]:[],productTypes:cr.ok?cr.body?.productTypes||[]:[],summaries:cr.ok?cr.body?.summaries||[]:[]};}
  const children=[];
  for(const plan of CHILDREN){
    const lr=await listingGet(token,plan.sku);const ls=listingSnapshot(plan,lr);
    let catalog=null;
    const asin=ls.actualAsin||plan.asin;
    if(asin){const cr=await catalogGet(token,asin);catalog={httpStatus:cr.http,ok:cr.ok,asin:cr.body?.asin||asin,relationshipAsins:cr.ok?[...new Set(collectAsinPaths(cr.body?.relationships||[]).map(x=>x.asin))]:[],relationships:cr.ok?cr.body?.relationships||[]:[],productTypes:cr.ok?cr.body?.productTypes||[]:[],summaries:cr.ok?cr.body?.summaries||[]:[],imageCount:cr.ok&&Array.isArray(cr.body?.images)?cr.body.images.reduce((n,x)=>n+(Array.isArray(x?.images)?x.images.length:0),0):0};}
    const parentContains=Boolean(parentCatalog?.relationshipAsins?.includes(plan.asin));
    const childPoints=Boolean(catalog?.relationshipAsins?.includes(parent.actualAsin||EXPECTED_PARENT_ASIN));
    children.push({...ls,catalog,checks:{listingAsinExact:ls.actualAsin===plan.asin,parentCatalogContainsChild:parentContains,childCatalogPointsToParent:childPoints,catalogLinked:parentContains&&childPoints}});
  }
  const healthy=children.filter(x=>x.role.startsWith("HEALTHY"));
  const target=children.filter(x=>x.role==="REPLACEMENT_TARGET");
  const commonKeyValues={};
  if(healthy.length){
    const keys=[...new Set(healthy.flatMap(x=>Object.keys(x.selectedAttributes||{})))].sort();
    for(const key of keys){const vals=healthy.map(x=>JSON.stringify(x.selectedAttributes?.[key]??null));if(new Set(vals).size===1)commonKeyValues[key]=healthy[0].selectedAttributes?.[key]??null;}
  }
  const parentContainsChildCount=children.filter(x=>x.checks.parentCatalogContainsChild).length;
  const childPointsToParentCount=children.filter(x=>x.checks.childCatalogPointsToParent).length;
  const catalogLinkedCount=children.filter(x=>x.checks.catalogLinked).length;
  return {
    ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,observedAt:new Date().toISOString(),readOnly:true,
    amazonPersistentWrites:0,priceWrites:0,inventoryWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0,
    productTypeDefinition:ptdSummary(schema),
    parent:{listing:parent,catalog:parentCatalog},
    children,
    healthyCanonical:{skus:healthy.map(x=>x.sku),commonSelectedAttributes:commonKeyValues,comparison:healthy.map(x=>({sku:x.sku,asin:x.actualAsin,ramGB:x.spec.ramGB,storageGB:x.spec.hardDiskGB,title:x.title,selectedAttributes:x.selectedAttributes,images:x.images,issueCount:x.issueCount,trademarkScan:x.contentTrademarkScan}))},
    replacementTargets:target.map(x=>({sku:x.sku,asin:x.actualAsin,ramGB:x.spec.ramGB,storageGB:x.spec.hardDiskGB,statuses:x.statuses,issueCount:x.issueCount,issues:x.issues,catalogLinked:x.checks.catalogLinked})),
    summary:{parentAsin:parent.actualAsin,parentAsinExact:parent.actualAsin===EXPECTED_PARENT_ASIN,parentContainsChildCount,childPointsToParentCount,catalogLinkedCount,healthyCount:healthy.length,replacementTargetCount:target.length,healthyTrademarkReferenceCount:healthy.reduce((n,x)=>n+(x.contentTrademarkScan?.total||0),0)},
    liveAllowed:false,liveBlockedReason:"EXPLICIT_USER_LIVE_APPROVAL_REQUIRED"
  };
}
async function handler(req,res){try{const sec=String(process.env.AMAZON_STOCK_API_SECRET||"").trim();if(!sec)return res.status(500).json({ok:false,readOnly:true,externalChanges:0,error:"secret missing"});if(String(req.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,readOnly:true,externalChanges:0,error:"Unauthorized"});if(req.body?.dryRun===false)throw new Error("LIVE_DISABLED_READ_ONLY_AUDIT");return res.status(200).json(await runAudit());}catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,amazonPersistentWrites:0,externalChanges:0,error:err?.message||String(err)});}}
express.application.listen=function g83ReplacementFreshAuditListen(...args){const exists=Boolean(this?._router?.stack?.some(l=>l?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);const server=originalListen.apply(this,args);if(!autoRunStarted){autoRunStarted=true;setTimeout(async()=>{try{console.log("G83_REPLACEMENT_FRESH_AUDIT_RESULT="+JSON.stringify(await runAudit()));}catch(err){console.error("G83_REPLACEMENT_FRESH_AUDIT_ERROR="+(err?.message||String(err)));}},3500);}return server;};
