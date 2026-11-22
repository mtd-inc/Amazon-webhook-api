import test from "node:test";
import assert from "node:assert/strict";
import {state,buildPreview} from "./s73_16_512_price_test_preview_preload.mjs";
const now=Date.parse("2026-11-22T03:00:00Z");
function listing(overrides={}) {
  return {
    summaries:[{asin:"B0HJ28YCP7",productType:"NOTEBOOK_COMPUTER",status:["BUYABLE","DISCOVERABLE"]}],
    fulfillmentAvailability:[{quantity:12}],
    issues:[],
    attributes:{purchasable_offer:[
      {currency:"JPY",audience:"ALL",marketplace_id:"A1VC38T7YXB528",
       our_price:[{schedule:[{value_with_tax:50800}]}],
       minimum_seller_allowed_price:[{schedule:[{value_with_tax:49500}]}],
       maximum_seller_allowed_price:[{schedule:[{value_with_tax:130000}]}]},
      {currency:"JPY",audience:"B2B",marketplace_id:"A1VC38T7YXB528",our_price:[{schedule:[{value_with_tax:49500}]}]}
    ]},...overrides
  };
}
test("changes only one consumer offer min and seven-day discounted price",()=>{
  const original=listing(),s=state(original,now),p=buildPreview(s,now);
  assert.deepEqual(p.blocks,[]);
  assert.equal(s.normal,50800);assert.equal(s.min,49500);
  assert.equal(p.offers[0].our_price[0].schedule[0].value_with_tax,50800);
  assert.equal(p.offers[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax,46800);
  assert.equal(p.offers[0].discounted_price[0].schedule[0].value_with_tax,47800);
  assert.equal(Date.parse(p.end)-now,7*86400000);
  assert.deepEqual(p.offers[1],original.attributes.purchasable_offer[1]);
  assert.equal(original.attributes.purchasable_offer[0].discounted_price,undefined);
});
test("blocks stale current price",()=>{
  const x=listing();x.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax=49800;
  assert.ok(buildPreview(state(x,now),now).blocks.includes("PRICE_DRIFT"));
});
test("blocks stale seller minimum",()=>{
  const x=listing();x.attributes.purchasable_offer[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax=49000;
  assert.ok(buildPreview(state(x,now),now).blocks.includes("MIN_DRIFT"));
});
test("blocks B2B drift and active consumer sale",()=>{
  const x=listing();x.attributes.purchasable_offer[1].our_price[0].schedule[0].value_with_tax=47900;
  x.attributes.purchasable_offer[0].discounted_price=[{schedule:[{value_with_tax:48800}]}];
  const blocks=buildPreview(state(x,now),now).blocks;
  assert.ok(blocks.includes("B2B_DRIFT"));assert.ok(blocks.includes("ACTIVE_SALE_CONFLICT"));
});
test("blocks missing stock and listing error",()=>{
  const x=listing({fulfillmentAvailability:[{quantity:0}],issues:[{code:"18155",severity:"ERROR"}]});
  const blocks=buildPreview(state(x,now),now).blocks;
  assert.ok(blocks.includes("NO_AVAILABLE_QUANTITY"));assert.ok(blocks.includes("LISTING_ERRORS"));
});
test("blocks wrong ASIN and no BUYABLE",()=>{
  const x=listing({summaries:[{asin:"B0HJL5MCV9",productType:"NOTEBOOK_COMPUTER",status:["DISCOVERABLE"]}]});
  const blocks=buildPreview(state(x,now),now).blocks;
  assert.ok(blocks.includes("ASIN_MISMATCH"));assert.ok(blocks.includes("NOT_BUYABLE"));
});
