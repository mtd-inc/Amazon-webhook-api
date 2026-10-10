import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import "./search_intelligence_generic_keyword_live_preload.mjs";
const target="/amazon/listing/search-intelligence-generic-keyword-live";
async function withServer(fn) {
  const app=express();app.use(express.json());
  const server=app.listen(0,"127.0.0.1");
  await once(server,"listening");
  try {await fn("http://127.0.0.1:"+server.address().port)}
  finally {await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()))}
}
async function request(url,headers={}) {
  const res=await fetch(url+target,{method:"POST",headers:{"content-type":"application/json",...headers},body:"{}"});
  return {status:res.status,data:await res.json()};
}
test("feature disabled: no authentication or SP-API calls",async()=>{
  const previous=process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED;
  delete process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED;
  try {await withServer(async url=>{
    const r=await request(url);
    assert.equal(r.status,503);assert.equal(r.data.reason,"FEATURE_DISABLED");
    assert.equal(r.data.livePatchSent,false);
  })} finally {if(previous===undefined) delete process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED;else process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED=previous}
});
test("unauthenticated request blocked before external calls",async()=>{
  const prior={...process.env};
  process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED="true";
  process.env.SI_GENERIC_KEYWORD_LIVE_SECRET="local-test-secret";
  try {await withServer(async url=>{
    const r=await request(url,{"x-si-live-secret":"wrong"});
    assert.equal(r.status,401);assert.equal(r.data.error,"UNAUTHORIZED");
    assert.equal(r.data.livePatchSent,false);
  })} finally {for(const key of ["SI_GENERIC_KEYWORD_LIVE_ENABLED","SI_GENERIC_KEYWORD_LIVE_SECRET"]){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key]}}
});

test("missing Control Plane configuration is rejected before Amazon authentication",async()=>{
  const keys=["SI_GENERIC_KEYWORD_LIVE_ENABLED","SI_GENERIC_KEYWORD_LIVE_SECRET",
    "LWA_CLIENT_ID","LWA_CLIENT_SECRET","REFRESH_TOKEN"];
  const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED="true";
  process.env.SI_GENERIC_KEYWORD_LIVE_SECRET="local-test-secret";
  delete process.env.LWA_CLIENT_ID;
  delete process.env.LWA_CLIENT_SECRET;
  delete process.env.REFRESH_TOKEN;
  try {
    await withServer(async url=>{
      const res=await fetch(url+target,{method:"POST",headers:{
        "content-type":"application/json","x-si-live-secret":"local-test-secret"
      },body:JSON.stringify({
        candidateId:"CAND-7X-725F-2ZML-DYNABOOK-20260921",
        sku:"7X-725F-2ZML",asin:"B0HGDBYRS8",field:"generic_keyword",
        currentHash:"a34a0414c1b595ac0a1b92df37ed93574f93e2399e88f540074883189f5f91db",
        proposedHash:"2bae817231822104a63b1c4a13c3be354feba6d42c34faf4263d75f4fff885d6",
        approvalId:"proposal-test",liveApprovalId:"live-test",approvalProof:"local-test",
        approvedAt:"2026-10-08T07:00:00Z",expiresAt:"2026-10-08T07:15:00Z"
      })});
      const data=await res.json();
      assert.equal(res.status,409);
      assert.equal(data.error,"LIVE_REQUIRED_CONFIG_MISSING");
      assert.equal(data.livePatchSent,false);
      assert.equal(data.livePatchAttempts,0);
    });
  } finally {
    for(const key of keys){
      if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];
    }
  }
});
