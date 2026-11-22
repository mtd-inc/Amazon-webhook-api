import express from "express";
import crypto from "node:crypto";

const ROUTE = "/amazon/price/x13/31800-test/preflight";
const SKU = "NY-G14F-GH8Y";
const ASIN = "B0FMS8XJ3D";
const MARKETPLACE = "A1VC38T7YXB528";
const EXPECTED = Object.freeze({ normal: 34900, min: 28800, b2b: 59850 });
const TARGET = Object.freeze({ sale: 31800, min: 28800, days: 7 });
// Preview-only economic assumptions, NOT verified purchased parts or serial allocations.
const ASSUMPTIONS = Object.freeze({memory:0,ssd:0,shippingPacking:1250,adsPerOrder:2000,points:349,referralFeeRate:0.10});
function estimatedContribution(baseCost) {
  const cost = baseCost+ASSUMPTIONS.memory+ASSUMPTIONS.ssd+ASSUMPTIONS.shippingPacking+ASSUMPTIONS.adsPerOrder+ASSUMPTIONS.points;
  return {baseCost,breakEvenAtHundred:Math.ceil(cost/(1-ASSUMPTIONS.referralFeeRate)/100)*100,contributionAt31800:TARGET.sale*(1-ASSUMPTIONS.referralFeeRate)-cost};
}
const originalListen = express.application.listen;

const clone = x => JSON.parse(JSON.stringify(x));
const number = x => x == null || x === "" ? null : (Number.isFinite(Number(x)) ? Number(x) : null);
const audience = x => String(x?.audience?.value || x?.audience || "ALL").toUpperCase();
function active(o, key, now) {
  const schedules = o?.[key]?.[0]?.schedule || [];
  return schedules.filter(s =>
    (!s.start_at || Date.parse(s.start_at) <= now) &&
    (!s.end_at || Date.parse(s.end_at) > now)
  ).sort((a,b) => (Date.parse(b.start_at || 0) || 0) - (Date.parse(a.start_at || 0) || 0))[0] || null;
}
function sameSecret(provided) {
  const actual = String(process.env.AMAZON_STOCK_API_SECRET || "");
  const p = Buffer.from(String(provided || "")), a = Buffer.from(actual);
  return a.length > 0 && a.length === p.length && crypto.timingSafeEqual(a, p);
}
async function lwaToken() {
  const {LWA_CLIENT_ID, LWA_CLIENT_SECRET, REFRESH_TOKEN} = process.env;
  if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !REFRESH_TOKEN) throw Error("LWA_ENV_MISSING");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"refresh_token",refresh_token:REFRESH_TOKEN,client_id:LWA_CLIENT_ID,client_secret:LWA_CLIENT_SECRET}),
    signal:AbortSignal.timeout(20000)
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw Error("LWA_HTTP_" + response.status);
  return json.access_token;
}
async function request(token, url, patch) {
  const response = await fetch(url, {
    method:patch ? "PATCH" : "GET",
    headers:{"x-amz-access-token":token,accept:"application/json",...(patch ? {"content-type":"application/json"} : {})},
    ...(patch ? {body:JSON.stringify(patch)} : {}),
    signal:AbortSignal.timeout(30000)
  });
  const payload = await response.json();
  return {http:response.status,ok:response.ok,payload};
}
function state(listing, now) {
  const summary = listing.summaries?.[0] || {};
  const offers = listing.attributes?.purchasable_offer || [];
  const consumer = offers.find(o => audience(o) === "ALL");
  const b2b = offers.find(o => audience(o) === "B2B");
  const consumerCount=offers.filter(o => audience(o)==="ALL").length;
  const b2bCount=offers.filter(o => audience(o)==="B2B").length;
  return {
    asin:summary.asin, productType:summary.productType, statuses:summary.status || [],
    qty:number(listing.fulfillmentAvailability?.[0]?.quantity),
    errorCodes:(listing.issues || []).filter(x => x.severity === "ERROR").map(x => x.code),
    offers,consumer,consumerCount,b2bCount,normal:number(active(consumer,"our_price",now)?.value_with_tax),
    sale:number(active(consumer,"discounted_price",now)?.value_with_tax),
    min:number(active(consumer,"minimum_seller_allowed_price",now)?.value_with_tax),
    b2b:number(active(b2b,"our_price",now)?.value_with_tax)
  };
}
function buildPreview(s, now) {
  const blocks = [];
  if (s.asin !== ASIN) blocks.push("ASIN_MISMATCH");
  if (s.productType !== "NOTEBOOK_COMPUTER") blocks.push("PRODUCT_TYPE_MISMATCH");
  if (s.consumerCount !== 1 || s.b2bCount !== 1) blocks.push("NON_UNIQUE_OFFER_AUDIENCE");
  if (!s.statuses.includes("BUYABLE")) blocks.push("NOT_BUYABLE");
  if (s.errorCodes.length) blocks.push("LISTING_ERRORS");
  if (!(s.qty > 0)) blocks.push("NO_AVAILABLE_QUANTITY");
  if (s.normal !== EXPECTED.normal) blocks.push("PRICE_DRIFT");
  if (s.min !== EXPECTED.min) blocks.push("MIN_DRIFT");
  if (s.b2b !== EXPECTED.b2b) blocks.push("B2B_DRIFT");
  if (s.sale !== null) blocks.push("ACTIVE_SALE_CONFLICT");
  if (!s.consumer || !s.productType) blocks.push("MISSING_CONSUMER_OR_PRODUCT_TYPE");
  if (blocks.length) return {blocks};
  const end = new Date(now + TARGET.days*86400000).toISOString();
  const start = new Date(now - 60000).toISOString();
  const offers = clone(s.offers);
  const i = offers.findIndex(x => audience(x) === "ALL");
  offers[i].discounted_price = [{schedule:[{value_with_tax:TARGET.sale,start_at:start,end_at:end}]}];
  const beforeB2b = s.offers.filter(x => audience(x) === "B2B");
  const afterB2b = offers.filter(x => audience(x) === "B2B");
  if (JSON.stringify(beforeB2b) !== JSON.stringify(afterB2b)) return {blocks:["B2B_MUTATION"]};
  if (JSON.stringify(offers.map(x => {const y=clone(x);if(audience(x)==="ALL"){delete y.discounted_price}return y})) !==
    JSON.stringify(s.offers.map(x => {const y=clone(x);if(audience(x)==="ALL"){delete y.discounted_price;delete y.minimum_seller_allowed_price}return y}))) return {blocks:["UNRELATED_OFFER_MUTATION"]};
  return {blocks:[],offers,start,end};
}
async function handler(req,res) {
  if (!sameSecret(req.headers["x-api-secret"])) return res.status(401).json({ok:false,decision:"UNAUTHORIZED",writes:0});
  if (req.body?.dryRun !== true || req.body?.liveConfirm ||
      (req.body?.sellerSku && req.body.sellerSku !== SKU) ||
      (req.body?.asin && req.body.asin !== ASIN)) return res.status(400).json({ok:false,decision:"EXACT_SCOPE_DRY_RUN_REQUIRED",writes:0});
  try {
    const seller = String(process.env.SPAPI_SELLER_ID||"");
    const mp = String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE);
    if (!seller || mp !== MARKETPLACE) throw Error("SELLER_OR_MARKETPLACE_INVALID");
    const endpoint = String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
    const base = endpoint + "/listings/2021-08-01/items/" + encodeURIComponent(seller) + "/" + encodeURIComponent(SKU);
    const token = await lwaToken();
    const get = await request(token,base+"?"+new URLSearchParams({marketplaceIds:mp,includedData:"summaries,attributes,issues,fulfillmentAvailability",issueLocale:"ja_JP"}));
    if (!get.ok) return res.status(502).json({ok:false,decision:"FRESH_GET_FAILED",http:get.http,writes:0});
    const fetchedAt = new Date().toISOString(), now = Date.now();
    const s = state(get.payload,now), plan = buildPreview(s,now);
    const result = {sku:SKU,asin:ASIN,fetchedAt,current:{normal:s.normal,min:s.min,sale:s.sale,b2b:s.b2b,quantity:s.qty,buyable:s.statuses.includes("BUYABLE"),listingErrors:s.errorCodes},target:TARGET,proposedStartAt:plan.start,proposedEndAt:plan.end,blocks:plan.blocks};
    if (plan.blocks.length) return res.status(200).json({ok:false,decision:"PREFLIGHT_BLOCKED",...result,writes:0});
    const patch = {productType:s.productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:plan.offers}]};
    const url = base+"?"+new URLSearchParams({marketplaceIds:mp,issueLocale:"ja_JP",mode:"VALIDATION_PREVIEW"});
    const preview = await request(token,url,patch);
    const issues = preview.payload.issues || [];
    const errors = issues.filter(x => String(x.severity).toUpperCase()==="ERROR");
    const valid = preview.ok && preview.payload.status === "VALID" && errors.length === 0;
    return res.status(200).json({
      ok:valid,decision:valid?"AMAZON_VALIDATED_COST_AND_LIVE_GATES_PENDING":"AMAZON_VALIDATION_BLOCKED",
      ...result,preview:{http:preview.http,status:preview.payload.status,issueCodes:issues.map(x=>x.code),errors:errors.length},
      safety:{persistentWrites:0,skuLimited:true,b2bUnchanged:true,otherSkuWrites:0,
        assumptionsOnly:true,estimatedLowCost:estimatedContribution(18500),
        estimatedHighCost:estimatedContribution(22550)},
      gatesPending:["APPROVED_SINGLE_SKU_LIVE_SCOPE","LOW_COST_SERIAL_ALLOCATION_EVIDENCE","REAL_UNIT_COST_AND_ALLOCATION_EVIDENCE",
        "POINTS_FEES_AD_SPEND_FRESH","LIVE_PRICE_AND_MIN_APPROVAL","SEVEN_DAY_MINIMUM_RESTORE_PLAN"],writes:0
    });
  } catch(e) {return res.status(502).json({ok:false,decision:"EXCEPTION",error:String(e.message||e).slice(0,160),writes:0});}
}
express.application.listen = function x13SingleSkuPreflightListen(...args) {
  if (!this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)) this.post(ROUTE,handler);
  return originalListen.apply(this,args);
};

export {state,buildPreview,estimatedContribution};
