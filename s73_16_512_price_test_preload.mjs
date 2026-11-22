import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

/**
 * S73/HS 16GB/512GB - one-SKU B2C normal-price PRICE_TEST.
 *
 * DRY/PREVIEW is read-only except for Amazon VALIDATION_PREVIEW (nonpersistent).
 * LIVE is closed unless BOTH an explicit scope-specific server-side approval
 * and an audited per-unit non-loss allocation have been configured.
 * Never use the historical six-SKU batch for this test.
 */
const VERSION = "2026-11-22-s73-16-512-price-test-v1.0.0";
const PREVIEW_ROUTE = "/amazon/price/s73-16-512/preview";
const LIVE_ROUTE = "/amazon/price/s73-16-512/live";
const MARKETPLACE = "A1VC38T7YXB528";
const TARGET = Object.freeze({
  sku: "s73-hs-i5-11g-16gb-ssd512",
  asin: "B0HJ28YCP7",
  currentPrice: 50800,
  currentMin: 49500,
  targetPrice: 47800,
  proposedMin: 47800,
  expectedB2b: 49500,
});
const OTHER_SKUS = Object.freeze([
  "s73-hs-i5-11g-8gb-ssd256",
  "s73-hs-i5-11g-8gb-ssd512",
  "s73-hs-i5-11g-8gb-ssd1tb",
  "7X-725F-2ZML",
  "s73-hs-i5-11g-16gb-ssd1tb",
]);
const APPROVAL = "S73_16_512_B2C_47800_MIN47800_LIVE_APPROVED";
const MAX_PREVIEW_AGE_MS = 15 * 60 * 1000;
const originalListen = express.application.listen;
const json = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const money = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const audience = (o) => String(typeof o?.audience === "string" ? o.audience : o?.audience?.value || "ALL").toUpperCase();
const active = (o, key) => {
  const schedules = o?.[key]?.[0]?.schedule;
  if (!Array.isArray(schedules)) return null;
  const now = Date.now();
  const matches = schedules.filter((v) =>
    (!v.start_at || Date.parse(v.start_at) <= now) &&
    (!v.end_at || Date.parse(v.end_at) > now));
  return matches.length === 1 ? matches[0] : null;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const h = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

function config() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE);
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId || marketplaceId !== MARKETPLACE || !endpoint.startsWith("https://")) throw new Error("SPAPI_CONFIG_INVALID");
  return { sellerId, marketplaceId, endpoint };
}
function authorized(req) {
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "");
  const value = String(req.headers["x-api-secret"] || "");
  if (!secret || !value) return false;
  const a = Buffer.from(secret), b = Buffer.from(value);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function apiToken() {
  const client_id = process.env.LWA_CLIENT_ID;
  const client_secret = process.env.LWA_CLIENT_SECRET;
  const refresh_token = process.env.REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) throw new Error("LWA_CONFIG_MISSING");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id, client_secret, refresh_token }),
    });
    const data = json(await r.text());
    if (!r.ok || !data.access_token) throw new Error("LWA_HTTP_" + r.status);
    return data.access_token;
  } finally { clearTimeout(t); }
}
async function request(url, token, method = "GET", body = null) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, {
      method, signal: controller.signal,
      headers: { "x-amz-access-token": token, accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const response = json(await r.text());
    if (!r.ok) throw new Error("SPAPI_" + method + "_HTTP_" + r.status + "_ISSUES_" +
      (response.issues || []).map((i) => i.code).join(","));
    return { status: r.status, body: response };
  } finally { clearTimeout(t); }
}
function pathFor(sku, mode) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  if (mode === "GET") q.set("includedData", "summaries,attributes,issues,offers,fulfillmentAvailability");
  if (mode === "PREVIEW") q.set("mode", "VALIDATION_PREVIEW");
  return endpoint + "/listings/2021-08-01/items/" +
    encodeURIComponent(sellerId) + "/" + encodeURIComponent(sku) + "?" + q.toString();
}
async function getListing(token, sku) {
  return (await request(pathFor(sku, "GET"), token)).body;
}
function snapshot(listing) {
  const summary = listing?.summaries?.[0] || {};
  const offers = clone(Array.isArray(listing?.attributes?.purchasable_offer) ?
    listing.attributes.purchasable_offer : []);
  const consumers = offers.map((offer, index) => ({ offer, index })).filter((x) => audience(x.offer) === "ALL");
  const b2bs = offers.filter((x) => audience(x) === "B2B");
  const consumer = consumers.length === 1 ? consumers[0].offer : null;
  const b2b = b2bs.length === 1 ? b2bs[0] : null;
  const pointsOffer = (listing?.offers || []).find((o) =>
    String(o.offerType || o.offer_type || "").toUpperCase() === "B2C" || audience(o) === "ALL");
  const points = money(pointsOffer?.points?.pointsNumber ?? pointsOffer?.points?.value ??
    pointsOffer?.points ?? null);
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const quantity = money(listing?.fulfillmentAvailability?.[0]?.quantity ??
    listing?.attributes?.fulfillment_availability?.[0]?.quantity);
  return {
    asin: String(summary.asin || ""),
    productType: String(summary.productType || ""),
    statuses: Array.isArray(summary.status) ? summary.status : [],
    errors: issues.filter((v) => String(v.severity || "").toUpperCase() === "ERROR").map((v) => v.code || "UNKNOWN"),
    quantity, offers,
    consumerIndex: consumers.length === 1 ? consumers[0].index : -1,
    consumerCount: consumers.length,
    b2bCount: b2bs.length,
    price: money(active(consumer, "our_price")?.value_with_tax),
    min: money(active(consumer, "minimum_seller_allowed_price")?.value_with_tax),
    sale: money(active(consumer, "discounted_price")?.value_with_tax),
    b2bPrice: money(active(b2b, "our_price")?.value_with_tax),
    points,
  };
}
function preflight(st) {
  const blocks = [];
  if (st.asin !== TARGET.asin) blocks.push("ASIN_MISMATCH");
  if (st.productType !== "NOTEBOOK_COMPUTER") blocks.push("PRODUCT_TYPE_MISMATCH");
  if (!st.statuses.includes("BUYABLE")) blocks.push("NOT_BUYABLE");
  if (st.errors.length) blocks.push("LISTING_ERROR");
  if (!(st.quantity > 0)) blocks.push("NO_LISTED_QUANTITY");
  if (st.consumerCount !== 1) blocks.push("CONSUMER_OFFER_NOT_UNIQUE");
  if (st.price !== TARGET.currentPrice) blocks.push("CURRENT_PRICE_DRIFT");
  if (st.min !== TARGET.currentMin) blocks.push("CURRENT_MIN_DRIFT");
  if (st.sale !== null) blocks.push("ACTIVE_SALE_PRESENT");
  if (st.b2bCount !== 1 || st.b2bPrice !== TARGET.expectedB2b) blocks.push("B2B_BASELINE_DRIFT");
  if (TARGET.proposedMin > TARGET.targetPrice) blocks.push("TARGET_MIN_EXCEEDS_PRICE");
  return blocks;
}
function makePatch(st) {
  const offers = clone(st.offers);
  const consumer = offers[st.consumerIndex];
  if (!consumer || audience(consumer) !== "ALL") throw new Error("CONSUMER_OFFER_MISSING");
  consumer.our_price = [{ schedule: [{ value_with_tax: TARGET.targetPrice }] }];
  consumer.minimum_seller_allowed_price = [{ schedule: [{ value_with_tax: TARGET.proposedMin }] }];
  const before = clone(st.offers), after = clone(offers);
  for (const set of [before, after]) {
    delete set[st.consumerIndex].our_price;
    delete set[st.consumerIndex].minimum_seller_allowed_price;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("UNRELATED_OFFER_MUTATION");
  return { productType: st.productType, patches: [{
    op: "replace", path: "/attributes/purchasable_offer", value: offers,
  }] };
}
async function validationPreview(token, patch) {
  const result = await request(pathFor(TARGET.sku, "PREVIEW"), token, "PATCH", patch);
  const issues = Array.isArray(result.body.issues) ? result.body.issues : [];
  const errors = issues.filter((x) => String(x.severity || "").toUpperCase() === "ERROR");
  const status = String(result.body.status || "").toUpperCase();
  return { httpStatus: result.status, status, issueCodes: issues.map((i) => i.code || ""),
    valid: errors.length === 0 && ["VALID", "ACCEPTED"].includes(status) };
}
let lastPreview = null;
let liveAttempted = false;
async function previewHandler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.body?.dryRun !== true ||
      (req.body.sellerSku && req.body.sellerSku !== TARGET.sku) ||
      (req.body.asin && req.body.asin !== TARGET.asin))
    return res.status(400).json({ ok: false, error: "EXACT_SKU_DRY_RUN_REQUIRED" });
  try {
    const token = await apiToken();
    const before = snapshot(await getListing(token, TARGET.sku));
    const blocks = preflight(before);
    if (blocks.length) return res.status(409).json({ ok: false, version: VERSION, externalChanges: 0,
      decision: "PREFLIGHT_BLOCKED", blocks, before: { price: before.price, min: before.min,
        b2bPrice: before.b2bPrice, points: before.points, quantity: before.quantity } });
    const payload = makePatch(before);
    const validation = await validationPreview(token, payload);
    const fresh = snapshot(await getListing(token, TARGET.sku));
    const unchanged = h(before) === h(fresh);
    if (!validation.valid || !unchanged) return res.status(409).json({
      ok: false, version: VERSION, externalChanges: 0, decision: "VALIDATION_OR_NONMUTATION_FAILED",
      validation, unchanged,
    });
    const fingerprint = h(before);
    lastPreview = { fingerprint, expires: Date.now() + MAX_PREVIEW_AGE_MS };
    return res.json({ ok: true, version: VERSION, route: PREVIEW_ROUTE, externalChanges: 0,
      decision: "VALIDATION_PREVIEW_PASS_LIVE_BLOCKED", target: TARGET,
      validation, fingerprint, previewExpiresAt: new Date(lastPreview.expires).toISOString(),
      b2bPreserved: true, otherFiveWrites: 0,
      economicsVerified: false, liveAllowed: false });
  } catch (e) {
    return res.status(500).json({ ok: false, version: VERSION, externalChanges: 0,
      decision: "DRY_FAIL_CLOSED", error: e.message });
  }
}
function economicsGate(st) {
  const e = process.env;
  const cost = money(e.S73_16_512_VERIFIED_ALLOCATED_UNIT_COST);
  const fees = money(e.S73_16_512_VERIFIED_FEES_SHIPPING_ADS);
  const maxPoints = money(e.S73_16_512_VERIFIED_MAX_POINTS);
  const evidence = String(e.S73_16_512_ALLOCATION_EVIDENCE || "");
  const scopeOk = e.S73_16_512_LIVE_APPROVAL === APPROVAL;
  const valuesOk = [cost, fees, maxPoints].every((x) => x !== null && x >= 0);
  const profit = valuesOk ? TARGET.targetPrice - cost - fees - maxPoints : null;
  return { allowed: scopeOk && valuesOk && evidence.length >= 12 &&
    st.points !== null && st.points <= maxPoints && profit !== null && profit >= 0,
    contributionAtApprovedWorstCase: profit, scopeApproved: scopeOk,
    allocationEvidencePresent: evidence.length >= 12, pointsVerified: st.points !== null,
    note: "Config requires verified per-unit allocation; not the common-pool listing count." };
}
function otherFiveFingerprint(listing) {
  const st = snapshot(listing);
  return h({ asin: st.asin, statuses: st.statuses, errors: st.errors,
    quantity: st.quantity, offers: st.offers });
}
async function captureOthers(token) {
  const values = {};
  for (const sku of OTHER_SKUS) {
    values[sku] = otherFiveFingerprint(await getListing(token, sku));
    await sleep(250);
  }
  return values;
}
async function liveHandler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.body?.liveConfirm !== APPROVAL || req.body?.sellerSku !== TARGET.sku ||
    req.body?.asin !== TARGET.asin || liveAttempted)
    return res.status(409).json({ ok: false, decision: "LIVE_SCOPE_OR_REPLAY_BLOCKED", externalChanges: 0 });
  let patchesAttempted = 0;
  try {
    const token = await apiToken();
    const before = snapshot(await getListing(token, TARGET.sku));
    const blocks = preflight(before);
    const gate = economicsGate(before);
    if (blocks.length || !gate.allowed || !lastPreview ||
      Date.now() > lastPreview.expires || h(before) !== lastPreview.fingerprint ||
      req.body.previewFingerprint !== lastPreview.fingerprint)
      return res.status(409).json({ ok: false, version: VERSION, decision: "LIVE_PREFLIGHT_BLOCKED",
        externalChanges: 0, blocks, economics: gate, previewValid: Boolean(lastPreview) });
    const otherBefore = await captureOthers(token);
    const validation = await validationPreview(token, makePatch(before));
    if (!validation.valid) return res.status(409).json({ ok: false, version: VERSION,
      decision: "LIVE_VALIDATION_BLOCKED", externalChanges: 0, validation });
    const freshest = snapshot(await getListing(token, TARGET.sku));
    if (h(before) !== h(freshest)) return res.status(409).json({ ok: false,
      decision: "LIVE_STALE_AFTER_PREVIEW", externalChanges: 0 });
    // One Amazon LIVE PATCH attempt. Never retry after a transport error.
    liveAttempted = true;
    patchesAttempted = 1;
    const submitted = await request(pathFor(TARGET.sku, "LIVE"), token, "PATCH", makePatch(freshest));
    const issues = Array.isArray(submitted.body.issues) ? submitted.body.issues : [];
    const accepted = ["ACCEPTED", "VALID"].includes(String(submitted.body.status || "").toUpperCase()) &&
      !issues.some((x) => String(x.severity || "").toUpperCase() === "ERROR");
    let targetFresh = null;
    if (accepted) {
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(2000);
        const now = snapshot(await getListing(token, TARGET.sku));
        if (now.price === TARGET.targetPrice && now.min === TARGET.proposedMin) {
          targetFresh = now;
          break;
        }
      }
    }
    const otherAfter = await captureOthers(token);
    const untouched = OTHER_SKUS.every((sku) => otherBefore[sku] === otherAfter[sku]);
    const verified = accepted && targetFresh !== null &&
      targetFresh.b2bPrice === before.b2bPrice &&
      JSON.stringify(targetFresh.offers.filter((o) => audience(o) === "B2B")) ===
      JSON.stringify(before.offers.filter((o) => audience(o) === "B2B")) &&
      targetFresh.statuses.includes("BUYABLE") && targetFresh.errors.length === 0 &&
      targetFresh.quantity === before.quantity && untouched;
    return res.status(verified ? 200 : 409).json({ ok: verified, version: VERSION, route: LIVE_ROUTE,
      decision: verified ? "PRICE_TEST_FRESH_VERIFIED_STARTED" : "LIVE_ATTEMPTED_VERIFY_INCOMPLETE_DO_NOT_RERUN",
      externalChanges: 1, patchesAttempted, accepted, targetPrice: TARGET.targetPrice,
      targetMin: TARGET.proposedMin, b2bUnchanged: targetFresh?.b2bPrice === before.b2bPrice,
      otherFiveUnchanged: untouched, freshVerifiedAt: verified ? new Date().toISOString() : null });
  } catch (e) {
    return res.status(500).json({ ok: false, version: VERSION,
      decision: patchesAttempted ? "LIVE_TRANSPORT_OR_READBACK_UNCERTAIN_DO_NOT_RERUN" : "LIVE_STOPPED_BEFORE_PATCH",
      externalChanges: patchesAttempted, patchesAttempted, error: e.message });
  }
}
express.application.listen = function s73PriceTestListen(...args) {
  if (!this.__s73_16_512_price_test_installed) {
    this.__s73_16_512_price_test_installed = true;
    this.post(PREVIEW_ROUTE, previewHandler);
    this.post(LIVE_ROUTE, liveHandler);
  }
  return originalListen.apply(this, args);
};
