import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const TAG = "CF_SV8_100238_PT06_DIRECT_LIVE_RESULT";
const ERR = "CF_SV8_100238_PT06_DIRECT_LIVE_ERROR";
const T = Object.freeze({
  sku: "cf-sv8-i5-8gb-ssd512",
  asin: "B0GH7GWDVP",
  productType: "NOTEBOOK_COMPUTER",
  marketplaceId: "A1VC38T7YXB528",
  issueCode: "100238",
  attributeName: "other_product_image_locator_6",
  mediaLocation: "https://m.media-amazon.com/images/I/61J1lchKXJL.jpg",
  controlAttributeName: "other_product_image_locator_5",
  controlMediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg",
  approvedPreviewSubmissionId: "df45a8d1a78c4b158d10178bbaf5a8a5",
  approvedSha256: "2327fa425c3bb40cd0de153fa6abd97007b2967a87716e1814e1208153b34c1f",
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const parse = t => { try { return t ? JSON.parse(t) : {}; } catch { return { raw: String(t).slice(0, 2000) }; } };
const hash = o => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");

function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || T.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("SELLER_ID_MISSING");
  if (marketplaceId !== T.marketplaceId) throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function lwa() {
  const { LWA_CLIENT_ID: client_id, LWA_CLIENT_SECRET: client_secret, REFRESH_TOKEN: refresh_token } = process.env;
  if (!client_id || !client_secret || !refresh_token) throw new Error("LWA_ENV_MISSING");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id, client_secret }),
  });
  const j = parse(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA_FAILED:${r.status}`);
  return j.access_token;
}

async function listing(token) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues", issueLocale: "ja_JP" });
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(T.sku)}?${q}`, {
    headers: { "x-amz-access-token": token, accept: "application/json" },
  });
  const j = parse(await r.text());
  if (!r.ok) throw new Error(`LISTING_GET_FAILED:${r.status}:${JSON.stringify(j)}`);
  return j;
}

function inspectBefore(j) {
  const s = Array.isArray(j?.summaries) ? j.summaries[0] || {} : {};
  const statuses = Array.isArray(s?.status) ? s.status.map(String) : [];
  if (String(s?.asin || "") !== T.asin) throw new Error(`ASIN_MISMATCH:${s?.asin || ""}`);
  if (String(s?.productType || "") !== T.productType) throw new Error(`PRODUCT_TYPE_MISMATCH:${s?.productType || ""}`);
  if (!statuses.includes("BUYABLE") || !statuses.includes("DISCOVERABLE")) throw new Error(`STATUS_CHANGED:${JSON.stringify(statuses)}`);
  const errors = (Array.isArray(j?.issues) ? j.issues : []).filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  if (errors.length !== 1) throw new Error(`ERROR_COUNT_CHANGED:${errors.length}`);
  const issue = errors[0];
  const attrs = Array.isArray(issue?.attributeNames) ? issue.attributeNames.map(String) : [];
  if (String(issue?.code || "") !== T.issueCode || !/PT\s*0*6/i.test(String(issue?.message || "")) || !attrs.includes("media_locator")) {
    throw new Error(`ISSUE_CHANGED:${JSON.stringify(issue)}`);
  }
  const a = j?.attributes || {};
  const target = a?.[T.attributeName];
  const control = a?.[T.controlAttributeName];
  if (!Array.isArray(target) || target.length !== 1) throw new Error("TARGET_SLOT_CARDINALITY_CHANGED");
  if (String(target[0]?.media_location || "") !== T.mediaLocation || String(target[0]?.marketplace_id || "") !== T.marketplaceId) throw new Error("TARGET_SLOT_CHANGED");
  if (!Array.isArray(control) || control.length !== 1 || String(control[0]?.media_location || "") !== T.controlMediaLocation) throw new Error("CONTROL_SLOT_CHANGED");
  return {
    statuses,
    issue: { code: String(issue.code), message: String(issue.message), attributeNames: attrs },
    value: [{ media_location: T.mediaLocation, marketplace_id: T.marketplaceId }],
  };
}

function body(value) {
  const b = { productType: T.productType, patches: [{ op: "delete", path: `/attributes/${T.attributeName}`, value }] };
  const sha = hash(b);
  if (sha !== T.approvedSha256) throw new Error(`PAYLOAD_SHA_MISMATCH:${sha}`);
  return b;
}

async function patch(token, b, preview) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues" });
  if (preview) q.set("mode", "VALIDATION_PREVIEW");
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(T.sku)}?${q}`, {
    method: "PATCH",
    headers: { "x-amz-access-token": token, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(b),
  });
  const j = parse(await r.text());
  const issues = Array.isArray(j?.issues) ? j.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const status = String(j?.status || "").toUpperCase();
  return { httpStatus: r.status, ok: r.ok, status, submissionId: String(j?.submissionId || ""), issues, errorCount: errors.length, accepted: r.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"), sha256: hash(b) };
}

function inspectAfter(j) {
  const s = Array.isArray(j?.summaries) ? j.summaries[0] || {} : {};
  const statuses = Array.isArray(s?.status) ? s.status.map(String) : [];
  const errors = (Array.isArray(j?.issues) ? j.issues : []).filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const target = j?.attributes?.[T.attributeName];
  return {
    asin: String(s?.asin || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    errorCount: errors.length,
    issue100238Present: errors.some(x => String(x?.code || "") === T.issueCode),
    targetSlotPresent: Array.isArray(target) && target.length > 0,
    targetSlotUrl: String(target?.[0]?.media_location || ""),
    errors: errors.map(x => ({ code: String(x?.code || ""), message: String(x?.message || "") })),
  };
}

async function run() {
  let amazonPersistentWrites = 0;
  const token = await lwa();
  const pre = inspectBefore(await listing(token));
  const b = body(pre.value);
  const validation = await patch(token, b, true);
  if (!validation.accepted) throw new Error(`FRESH_PREVIEW_BLOCK:${JSON.stringify(validation)}`);
  const preLive = inspectBefore(await listing(token));
  const b2 = body(preLive.value);
  const live = await patch(token, b2, false);
  if (!live.accepted) throw new Error(`LIVE_NOT_ACCEPTED:${JSON.stringify(live)}`);
  amazonPersistentWrites = 1;

  let finalFresh = null;
  let attempts = 0;
  for (const delay of [3000, 5000, 10000, 15000, 20000]) {
    await sleep(delay);
    attempts += 1;
    finalFresh = inspectAfter(await listing(token));
    if (finalFresh.asin === T.asin && finalFresh.buyable && finalFresh.discoverable && finalFresh.errorCount === 0 && !finalFresh.issue100238Present && !finalFresh.targetSlotPresent) break;
  }
  const verified = Boolean(finalFresh && finalFresh.asin === T.asin && finalFresh.buyable && finalFresh.discoverable && finalFresh.errorCount === 0 && !finalFresh.issue100238Present && !finalFresh.targetSlotPresent);
  return {
    status: verified ? "CF_SV8_100238_PT06_LIVE_VERIFIED_PASS" : "CF_SV8_100238_PT06_LIVE_ACCEPTED_PROPAGATION_PENDING",
    sellerSku: T.sku,
    asin: T.asin,
    issueCode: T.issueCode,
    targetPath: `/attributes/${T.attributeName}`,
    approvedPreviewSubmissionId: T.approvedPreviewSubmissionId,
    approvedSha256: T.approvedSha256,
    preLive: pre,
    freshValidationPreview: validation,
    live,
    verificationAttempts: attempts,
    finalFresh,
    verified,
    amazonPersistentWrites,
    priceMutation: 0,
    inventoryMutation: 0,
    b2bMutation: 0,
    amazonAdsMutation: 0,
    yahooMutation: 0,
    variationRelationMutation: 0,
    otherContentMutation: 0,
    externalChanges: amazonPersistentWrites,
  };
}

setTimeout(async () => {
  try {
    console.log(`${TAG}=${JSON.stringify(await run())}`);
  } catch (e) {
    console.error(`${ERR}=${JSON.stringify({ sellerSku: T.sku, asin: T.asin, approvedPreviewSubmissionId: T.approvedPreviewSubmissionId, approvedSha256: T.approvedSha256, error: e?.message || String(e), amazonPersistentWrites: 0, priceMutation: 0, inventoryMutation: 0, b2bMutation: 0, amazonAdsMutation: 0, yahooMutation: 0, variationRelationMutation: 0, otherContentMutation: 0, externalChanges: 0 })}`);
  }
}, 2500);
