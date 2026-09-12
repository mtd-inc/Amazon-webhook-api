import fetch from "node-fetch";
import "dotenv/config";

const TAG="S73_SIX_CHILD_POSTLIVE_AUDIT_RESULT";
const MP="A1VC38T7YXB528";
const PARENT_SKU="s73-hs-i5-11g-16gb-storage-parent";
const PARENT_ASIN="B0HJ265LZ6";
const EXPECTED=[
 {sku:"7X-725F-2ZML",asin:"B0HGDBYRS8",ram:16,storage:256},
 {sku:"s73-hs-i5-11g-16gb-ssd512",asin:"B0HJ28YCP7",ram:16,storage:512},
 {sku:"s73-hs-i5-11g-8gb-ssd256",ram:8,storage:256},
 {sku:"s73-hs-i5-11g-8gb-ssd512",ram:8,storage:512},
 {sku:"s73-hs-i5-11g-8gb-ssd1tb",ram:8,storage:1024},
 {sku:"s73-hs-i5-11g-16gb-ssd1tb",ram:16,storage:1024},
];
const jp=t=>{try{return t?JSON.parse(t):{};}catch{return{rawText:String(t||"").slice(0,2000)}}};
async function ft(url,opt={}){const c=new AbortController(),tm=setTimeout(()=>c.abort(),30000);try{return await fetch(url,{...opt,signal:c.signal})}finally{clearTimeout(tm)}}
async function token(){const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:process.env.REFRESH_TOKEN,client_id:process.env.LWA_CLIENT_ID,client_secret:process.env.LWA_CLIENT_SECRET})});const x=jp(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA_${r.status}`);return x.access_token;}
function cfg(){return{sellerId:String(process.env.SPAPI_SELLER_ID||"").trim(),endpoint:String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"")};}
async function req(url,a){const r=await ft(url,{headers:{"x-amz-access-token":a,accept:"application/json"}});return{http:r.status,ok:r.ok,body:jp(await r.text())};}
async function listing(a,sku){const{sellerId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:MP,includedData:"summaries,attributes,issues",issueLocale:"ja_JP"});return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a);}
async function catalog(a,asin){const{endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:MP,includedData:"relationships,summaries"});return req(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`,a);}
function m(rows,key){return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0]?.[key])?rows[0][key][0]:null}
function gb(x){if(!x)return null;const n=Number(x.value),u=String(x.unit||"GB").toUpperCase();return u==="TB"?n*1024:u==="MB"?n/1024:n}
function rel(a){return{parentage:String(a?.parentage_level?.[0]?.value||""),parentSku:String(a?.child_parent_sku_relationship?.[0]?.parent_sku||""),relationship:String(a?.child_parent_sku_relationship?.[0]?.child_relationship_type||""),theme:String(a?.variation_theme?.[0]?.name||"")}}
function errs(b){return(Array.isArray(b?.issues)?b.issues:[]).filter(x=>String(x?.severity||"").toUpperCase()==="ERROR")}
function catChildren(b){const out=[];for(const x of Array.isArray(b?.relationships)?b.relationships:[])for(const r of Array.isArray(x?.relationships)?x.relationships:[])if(String(r?.type||"").toUpperCase()==="VARIATION")out.push(...(r.childAsins||[]));return[...new Set(out.map(String))]}
async function run(){const a=await token();const p=await listing(a,PARENT_SKU),pa=p.body?.attributes||{},ps=p.body?.summaries?.[0]||{};const pc=await catalog(a,PARENT_ASIN);const children=[];for(const e of EXPECTED){const g=await listing(a,e.sku),at=g.body?.attributes||{},sm=g.body?.summaries?.[0]||{};children.push({sku:e.sku,http:g.http,asin:String(sm.asin||""),productType:String(sm.productType||""),statuses:Array.isArray(sm.statuses)?sm.statuses:[],ramGB:gb(m(at.ram_memory,"installed_size")),storageGB:gb(m(at.hard_disk,"size"))??gb(m(at.flash_memory,"installed_size")),errorCount:errs(g.body).length,relation:rel(at)});}const cat=catChildren(pc.body),asins=children.map(x=>x.asin).filter(Boolean);const expectedTheme="HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";const listingPass=children.every((x,i)=>x.http===200&&x.asin&&x.productType==="NOTEBOOK_COMPUTER"&&x.errorCount===0&&x.ramGB===EXPECTED[i].ram&&x.storageGB===EXPECTED[i].storage&&x.relation.parentage==="child"&&x.relation.parentSku===PARENT_SKU&&x.relation.theme===expectedTheme);const parentPass=p.http===200&&String(ps.asin||"")===PARENT_ASIN&&errs(p.body).length===0&&rel(pa).parentage==="parent"&&rel(pa).theme===expectedTheme&&!Array.isArray(pa.ram_memory);const catalogPass=pc.http===200&&cat.length===6&&asins.length===6&&asins.every(x=>cat.includes(x));return{status:parentPass&&listingPass&&catalogPass?"S73_CATALOG_6_OF_6_PASS":"S73_POSTLIVE_PROPAGATION_PENDING",readOnly:true,parent:{sku:PARENT_SKU,asin:String(ps.asin||""),errorCount:errs(p.body).length,relation:rel(pa),ramAttributePresent:Array.isArray(pa.ram_memory)},children,parentCatalog:{http:pc.http,childAsins:cat},parentPass,listingPass,catalogPass,amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0};}
setTimeout(()=>run().then(x=>console.log(`${TAG}=${JSON.stringify(x)}`)).catch(e=>console.error(`${TAG}=${JSON.stringify({status:"AUDIT_ERROR",error:e?.message||String(e),readOnly:true,amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,b2bWrites:0,adsWrites:0,yahooWrites:0,externalChanges:0})}`)),7000);
