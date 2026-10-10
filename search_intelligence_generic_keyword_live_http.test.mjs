import {test} from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {once} from "node:events";
import {TARGET,executeLive} from "./search_intelligence_generic_keyword_live_core.mjs";
const body={candidateId:TARGET.candidateId,sku:TARGET.sku,asin:TARGET.asin,field:TARGET.field,currentHash:TARGET.currentHash,proposedHash:TARGET.proposedHash,approvalId:"proposal",liveApprovalId:"live",approvalProof:"bound",approvedAt:"2026-10-08T07:00:00Z",expiresAt:"2026-10-08T07:15:00Z"};
const now=()=>Date.parse("2026-10-08T07:05:00Z");
async function mockedHttp({rejectGate=false,timeoutOnLive=false}={}){
  const state={reserved:false,verify:0,reserve:0,preview:0,live:0};
  const server=http.createServer(async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(chunk);
    let input={};try{input=JSON.parse(Buffer.concat(parts).toString()||"{}")}catch{}
    res.setHeader("content-type","application/json");
    if(req.url==="/gate"){
      if(input.operation==="VERIFY"){state.verify++;res.statusCode=rejectGate?403:200;res.end(JSON.stringify({ok:!rejectGate}));return}
      if(input.operation==="RESERVE"){state.reserve++;if(state.reserved){res.statusCode=409;res.end(JSON.stringify({ok:false}));return}state.reserved=true;res.end(JSON.stringify({ok:true}));return}
    }
    if(req.url==="/listing"){res.end(JSON.stringify({summaries:[{asin:TARGET.asin,productType:"NOTEBOOK_COMPUTER"}],attributes:{generic_keyword:[{value:TARGET.current,language_tag:"ja_JP",marketplace_id:"A1VC38T7YXB528"}]}}));return}
    if(req.url==="/preview"){state.preview++;assert.equal(input.patches?.length,1);assert.equal(input.patches[0].path,"/attributes/generic_keyword");res.end(JSON.stringify({valid:true,errorCount:0,issueCount:0}));return}
    if(req.url==="/live"){state.live++;if(timeoutOnLive){res.destroy();return}res.end(JSON.stringify({status:"ACCEPTED"}));return}
    res.statusCode=404;res.end("{}");
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base="http://127.0.0.1:"+server.address().port;
  const call=async(path,requestBody)=>{const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(requestBody)});if(!r.ok)throw Error("HTTP_"+r.status);return r.json()};
  const run=()=>executeLive({input:body,now,verifyProof:async()=>{const r=await call("/gate",{operation:"VERIFY"});return r.ok},reserve:async()=>{try{const r=await call("/gate",{operation:"RESERVE"});return r.ok}catch{return false}},read:()=>call("/listing",{}),preview:patches=>call("/preview",{patches}),live:patches=>call("/live",{patches})});
  return {run,state,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
test("real localhost HTTP: gate -> GET -> preview -> reserve -> one PATCH",async()=>{const m=await mockedHttp();try{const result=await m.run();assert.equal(result.liveAttempted,true);assert.equal(m.state.live,1);assert.equal(m.state.reserve,1);assert.equal(m.state.preview,1)}finally{await m.close()}});
test("real localhost HTTP: denied gate results in zero PATCH",async()=>{const m=await mockedHttp({rejectGate:true});try{await assert.rejects(()=>m.run(),/HTTP_403/);assert.equal(m.state.live,0);assert.equal(m.state.reserve,0)}finally{await m.close()}});
test("real localhost HTTP: replay cannot reserve or send again",async()=>{const m=await mockedHttp();try{await m.run();await assert.rejects(()=>m.run(),/ALREADY_RESERVED/);assert.equal(m.state.live,1)}finally{await m.close()}});
test("real localhost HTTP: lost LIVE response is not retried",async()=>{const m=await mockedHttp({timeoutOnLive:true});try{await assert.rejects(()=>m.run());assert.equal(m.state.live,1);await assert.rejects(()=>m.run(),/ALREADY_RESERVED/);assert.equal(m.state.live,1)}finally{await m.close()}});
