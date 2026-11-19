import crypto from "node:crypto";
const TARGETS = {"x280-i5-8gb-ssd256":"B0GHYT9XVK","x280-i5-8gb-ssd1":"B0GHYFKBL8"};
const TEXT_FIELDS = ["item_name","bullet_point","product_description","model_name","generic_keyword"];
const MP="A1VC38T7YXB528";
const sha=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const kana=s=>String(s).replace(/thinkpad/gi,"シンクパッド");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function patchValue(x) {
 if(Array.isArray(x))return x.map(patchValue);
 if(x&&typeof x==="object")return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,k==="value"&&typeof v==="string"?kana(v):patchValue(v)]));
 return x;
}
function issues(xs){return(xs||[]).map(x=>({code:String(x.code||""),severity:String(x.severity||""),message:String(x.message||"").slice(0,100)}))}
function build(item,sku){
 const summary=item.summaries?.[0]||{};
 if(summary.asin!==TARGETS[sku]||summary.productType!=="NOTEBOOK_COMPUTER")throw Error("TARGET_IDENTITY_MISMATCH");
 const a=item.attributes||{};
 if(a.brand?.some(x=>x.value!=="MTD")||a.manufacturer?.some(x=>x.value!=="MTD"))throw Error("PROTECTED_BRAND_MISMATCH");
 const patches=[];
 for(const field of TEXT_FIELDS){
  const orig=a[field];if(!Array.isArray(orig)||!/thinkpad/i.test(JSON.stringify(orig)))continue;
  const value=patchValue(orig);
  if(JSON.stringify(value)!==JSON.stringify(orig))patches.push({op:"replace",path:"/attributes/"+field,value});
 }
 const original=Object.fromEntries(patches.map(p=>[p.path,a[p.path.split("/").at(-1)]]));
 return {sku,asin:summary.asin,titleBefore:a.item_name?.[0]?.value||summary.itemName||"",titleAfter:kana(a.item_name?.[0]?.value||summary.itemName||""),fingerprint:sha({sku,asin:summary.asin,original}),paths:patches.map(p=>p.path),patches,issueCodes:issues(item.issues).map(x=>x.code)};
}
export function registerX280KanaOneShotRoutes(app,opts){
 const {spApiRequest,sellerId,apiSecret}=opts;
 if(!app||!spApiRequest||!sellerId||!apiSecret)throw Error("MISSING_DEPENDENCY");
 const path=sku=>"/listings/2021-08-01/items/"+encodeURIComponent(sellerId)+"/"+encodeURIComponent(sku);
 const get=sku=>spApiRequest({method:"GET",path:path(sku),query:{marketplaceIds:MP,issueLocale:"ja_JP",includedData:"summaries,attributes,issues"}});
 const patch=(sku,patches,preview)=>spApiRequest({method:"PATCH",path:path(sku),query:{marketplaceIds:MP,issueLocale:"ja_JP",includedData:"issues",...(preview?{mode:"VALIDATION_PREVIEW"}:{})},body:{productType:"NOTEBOOK_COMPUTER",patches}});
 app.post("/ads/listings/x280-kana-one-shot",async(req,res)=>{
  if(req.get("X-API-SECRET")!==apiSecret)return res.status(401).json({ok:false,error:"UNAUTHORIZED"});
  const mode=String(req.body?.mode||"preview");
  if(!["preview","live"].includes(mode))return res.status(400).json({ok:false,error:"BAD_MODE"});
  const fps=req.body?.fingerprints||{};
  const output={ok:false,mode,at:new Date().toISOString(),results:[],liveAttempts:0,scope:"TWO_X280_SKUS_TEXT_ONLY",otherChanges:0};
  try{
   if(mode==="live"&&Object.keys(fps).sort().join(",")!==Object.keys(TARGETS).sort().join(","))throw Error("FINGERPRINT_KEYS_MISMATCH");
   const plans=[];
   for(const sku of Object.keys(TARGETS)){
    const row=build(await get(sku),sku);
    if(mode==="live"&&fps[sku]!==row.fingerprint)throw Error("SOURCE_DRIFT_"+sku);
    const pv=row.patches.length?await patch(sku,row.patches,true):{status:"NO_CHANGE",issues:[]};
    const pvIssues=issues(pv.issues),pvStatus=String(pv.status||"").toUpperCase();
    const unexpected=pvIssues.filter(x=>x.severity.toUpperCase()==="ERROR"&&!["100238","18146"].includes(x.code));
    const ready=!row.patches.length||(["VALID","ACCEPTED"].includes(pvStatus)&&!unexpected.length);
    output.results.push({sku,asin:row.asin,titleBefore:row.titleBefore,titleAfter:row.titleAfter,paths:row.paths,preIssueCodes:row.issueCodes,fingerprint:row.fingerprint,preview:{status:pvStatus,issues:pvIssues,ready}});
    plans.push(row);
    if(!ready)throw Error("VALIDATION_PREVIEW_BLOCK_"+sku+"_"+pvStatus);
   }
   if(mode==="preview"){output.ok=true;output.status="PREVIEW_READY";return res.json(output)}
   for(let i=0;i<plans.length;i++){
    const row=plans[i],result=output.results[i];
    if(!row.patches.length){result.live="SKIPPED_ALREADY_CLEAN";continue}
    const fresh=build(await get(row.sku),row.sku);
    if(fresh.fingerprint!==row.fingerprint)throw Error("FRESH_DRIFT_BEFORE_LIVE_"+row.sku);
    output.liveAttempts++;
    const r=await patch(row.sku,row.patches,false);
    result.live={status:r.status||"",submissionId:r.submissionId||"",issues:issues(r.issues)};
    if(!["ACCEPTED","VALID"].includes(String(r.status||"").toUpperCase()))throw Error("LIVE_REJECTED_"+row.sku);
    let verified=false;
    for(let attempt=1;attempt<=5;attempt++){
     await sleep(attempt===1?4000:3000);
     const after=build(await get(row.sku),row.sku);
     result.readback={attempt,remaining:after.paths,title:after.titleBefore,issueCodes:after.issueCodes};
     if(!after.patches.length){verified=true;break}
    }
    if(!verified)throw Error("READBACK_PENDING_"+row.sku);
   }
   output.ok=true;output.status="FRESH_VERIFIED";return res.json(output);
  }catch(e){output.error=String(e.message||e);output.status="HALTED";return res.status(409).json(output)}
 });
}
