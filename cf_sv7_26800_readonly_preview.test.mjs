import test from "node:test";
import assert from "node:assert/strict";
import {parse,plan,economics,run} from "./cf_sv7_26800_readonly_preview_preload.mjs";
const now=Date.parse("2026-11-23T00:00:00.000Z");
function listing(overrides={}){
 return {
  summaries:[{asin:"B0GH73M1BH",productType:"NOTEBOOK_COMPUTER",status:["BUYABLE","DISCOVERABLE"]}],
  fulfillmentAvailability:[{quantity:4}],issues:[],
  attributes:{purchasable_offer:[
   {currency:"JPY",audience:"ALL",marketplace_id:"A1VC38T7YXB528",
    our_price:[{schedule:[{value_with_tax:29800}]}],
    minimum_seller_allowed_price:[{schedule:[{value_with_tax:22000}]}],
    maximum_seller_allowed_price:[{schedule:[{value_with_tax:36000}]}]},
   {currency:"JPY",audience:"B2B",marketplace_id:"A1VC38T7YXB528",
    our_price:[{schedule:[{value_with_tax:28800}]}]}
  ]},...overrides
 };
}
test("only X13-adjacent SV7 target changes and B2B/seller minimum intact",()=>{
 const before=listing(),p=plan(before,now);
 assert.deepEqual(p.blocks,[]);
 assert.equal(p.s.normal,29800);assert.equal(p.s.min,22000);
 assert.equal(p.offers[0].discounted_price[0].schedule[0].value_with_tax,26800);
 assert.equal(p.offers[0].our_price[0].schedule[0].value_with_tax,29800);
 assert.equal(p.offers[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax,22000);
 assert.deepEqual(p.offers[1],before.attributes.purchasable_offer[1]);
 assert.equal(Date.parse(p.end)-now,7*86400000);
 assert.equal(before.attributes.purchasable_offer[0].discounted_price,undefined);
});
test("blocks ASIN mismatch",()=>{const x=listing();x.summaries[0].asin="B0FMS8XJ3D";assert.ok(plan(x,now).blocks.includes("ASIN_MISMATCH"));});
test("blocks normal and seller minimum drift",()=>{const x=listing();x.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=29000;x.attributes.purchasable_offer[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax=22500;let b=plan(x,now).blocks;assert.ok(b.includes("NORMAL_PRICE_DRIFT"));assert.ok(b.includes("SELLER_MINIMUM_DRIFT"));});
test("blocks active sale and future schedule",()=>{
 const x=listing();x.attributes.purchasable_offer[0].discounted_price=[{schedule:[{start_at:"2026-11-23T01:00:00.000Z",end_at:"2026-11-30T00:00:00.000Z",value_with_tax:25000}]}];
 assert.ok(plan(x,now).blocks.includes("FUTURE_SALE_CONFLICT"));
 x.attributes.purchasable_offer[0].discounted_price=[{schedule:[{start_at:"2026-11-22T00:00:00.000Z",end_at:"2026-11-28T00:00:00.000Z",value_with_tax:25000}]}];
 assert.ok(plan(x,now).blocks.includes("ACTIVE_SALE_CONFLICT"));
});
test("blocks no quantity and listing issues",()=>{
 const x=listing({fulfillmentAvailability:[{quantity:0}],issues:[{code:"18155",severity:"ERROR"}]});
 const b=plan(x,now).blocks;assert.ok(b.includes("NO_AVAILABLE_QUANTITY"));assert.ok(b.includes("LISTING_ERRORS"));
});
test("blocks duplicate or unexpected audiences",()=>{
 const x=listing();x.attributes.purchasable_offer.push({...x.attributes.purchasable_offer[0]});
 assert.ok(plan(x,now).blocks.includes("UNEXPECTED_OFFER_AUDIENCES"));
});
test("no B2B offer is permitted without invented values",()=>{
 const x=listing();x.attributes.purchasable_offer=x.attributes.purchasable_offer.slice(0,1);
 const p=plan(x,now);assert.deepEqual(p.blocks,[]);assert.equal(p.s.b2bPrice,null);assert.equal(p.offers.length,1);
});
test("representative and high-cost sensitivity estimates, separate from verified fees",()=>{
 assert.equal(economics(16953,268).contributionAt26800,3649);
 assert.equal(economics(19600,268).contributionAt26800,1002);
 assert.equal(economics(16953,298).contributionAt26800,3619);
});
test("disabled by default: no Amazon access",async()=>{
 assert.equal((await run()).status,"DISABLED");
});
