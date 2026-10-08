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
