import test from "node:test";
import assert from "node:assert/strict";
import {state,buildPreview,estimatedContribution} from "./x13_31800_7d_price_preview_preload.mjs";
const now=Date.parse("2026-11-22T03:00:00Z");
function listing(overrides={}) {
  return {
    summaries:[{asin:"B0FMS8XJ3D",productType:"NOTEBOOK_COMPUTER",status:["BUYABLE","DISCOVERABLE"]}],
    fulfillmentAvailability:[{quantity:12}],
    issues:[],
    attributes:{purchasable_offer:[
      {currency:"JPY",audience:"ALL",marketplace_id:"A1VC38T7YXB528",
       our_price:[{schedule:[{value_with_tax:34900}]}],
       minimum_seller_allowed_price:[{schedule:[{value_with_tax:28800}]}],
       maximum_seller_allowed_price:[{schedule:[{value_with_tax:130000}]}]},
      {currency:"JPY",audience:"B2B",marketplace_id:"A1VC38T7YXB528",our_price:[{schedule:[{value_with_tax:28800}]}]}
    ]},...overrides
  };
}
test("changes only one consumer offer min and seven-day discounted price",()=>{
  const original=listing(),s=state(original,now),p=buildPreview(s,now);
  assert.deepEqual(p.blocks,[]);
  assert.equal(s.normal,34900);assert.equal(s.min,28800);
  assert.equal(p.offers[0].our_price[0].schedule[0].value_with_tax,34900);
  assert.equal(p.offers[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax,31800);
  assert.equal(p.offers[0].discounted_price[0].schedule[0].value_with_tax,31800);
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

test("blocks unexpected product type and duplicate consumer offer",()=>{
  const x=listing();x.summaries[0].productType="OTHER";x.attributes.purchasable_offer.push({...x.attributes.purchasable_offer[0]});
  const blocks=buildPreview(state(x,now),now).blocks;
  assert.ok(blocks.includes("PRODUCT_TYPE_MISMATCH"));
  assert.ok(blocks.includes("NON_UNIQUE_OFFER_AUDIENCE"));
});
test("cost estimates show positive contribution for low and high recorded base costs",()=>{
  const low=estimatedContribution(18500),high=estimatedContribution(22550);
  assert.equal(low.contributionAt31800,6521);
  assert.equal(high.contributionAt31800,2471);
  assert.ok(low.breakEvenAtHundred<31800);
  assert.ok(high.breakEvenAtHundred<31800);
});
