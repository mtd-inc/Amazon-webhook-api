import { test } from "node:test";
import assert from "node:assert/strict";
import { TARGET } from "./search_intelligence_generic_keyword_live_core.mjs";
import { buildSpApiRequest } from "./search_intelligence_generic_keyword_spapi_contract.mjs";
const base={sellerId:"SELLER-TEST",sku:TARGET.sku,accessToken:"TOKEN-TEST"};
const patches=[{op:"replace",path:"/attributes/generic_keyword",value:[{value:TARGET.proposed,language_tag:"ja_JP"}]}];
test("GET has includedData without mode or PATCH body",()=>{
 const req=buildSpApiRequest({...base,mode:"GET"});
 const url=new URL(req.url);
 assert.equal(req.options.method,"GET");
 assert.equal(url.searchParams.get("includedData"),"summaries,attributes,issues");
 assert.equal(url.searchParams.has("mode"),false);
 assert.equal(req.options.body,undefined);
});
test("VALIDATION_PREVIEW has mode and only target patch",()=>{
 const req=buildSpApiRequest({...base,mode:"PREVIEW",patches});
 const url=new URL(req.url);
 assert.equal(req.options.method,"PATCH");
 assert.equal(url.searchParams.get("mode"),"VALIDATION_PREVIEW");
 assert.equal(url.searchParams.has("includedData"),false);
 assert.equal(JSON.parse(req.options.body).patches.length,1);
});
test("LIVE PATCH cannot carry preview mode or includedData",()=>{
 const req=buildSpApiRequest({...base,mode:"LIVE",patches});
 const url=new URL(req.url);
 assert.equal(req.options.method,"PATCH");
 assert.equal(url.searchParams.has("mode"),false);
 assert.equal(url.searchParams.has("includedData"),false);
 assert.equal(JSON.parse(req.options.body).productType,"NOTEBOOK_COMPUTER");
});
test("reject unauthorized API endpoint",()=>assert.throws(()=>buildSpApiRequest({...base,mode:"GET",endpoint:"https://example.invalid"}),/UNTRUSTED_SPAPI_ENDPOINT/));
test("reject unrelated patches",()=>assert.throws(()=>buildSpApiRequest({...base,mode:"LIVE",patches:[{op:"replace",path:"/attributes/item_name",value:[{value:"changed"}]}]}),/SPAPI_PATCH_SCOPE_INVALID/));
test("reject multiple patches",()=>assert.throws(()=>buildSpApiRequest({...base,mode:"LIVE",patches:[...patches,...patches]}),/SPAPI_PATCH_SCOPE_INVALID/));
