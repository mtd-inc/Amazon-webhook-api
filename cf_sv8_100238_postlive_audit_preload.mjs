import "./s73_six_child_validation_preview_preload.mjs";
import "./cf_sv8_trademark_risk_audit_preload.mjs";
import fetch from "node-fetch";
import "dotenv/config";

const TAG = "CF_SV8_100238_POSTLIVE_AUDIT_RESULT";
const ERR = "CF_SV8_100238_POSTLIVE_AUDIT_ERROR";
const T = Object.freeze({
  sku: "cf-sv8-i5-8gb-ssd512",
  asin: "B0GH7GWDVP",
  marketplaceId: "A1VC38T7YXB528",
  issueCode: "100238",
  attributeName: "other_product_image_locator_6",
});

const parse = t => { try { return t ? JSON.parse(t) : {}; } catch { return { raw: String(t).slice(0, 2000) }; } };

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
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || T.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("SELLER_ID_MISSING");
  if (marketplaceId !== T.marketplaceId) throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues", issueLocale: "ja_JP" });
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(T.sku)}?${q}`, {
    headers: { "x-amz-access-token": token, accept: "application/json" },
  });
  const j = parse(await r.text());
  if (!r.ok) throw new Error(`LISTING_GET_FAILED:${r.status}:${JSON.stringify(j)}`);
  return j;
}

setTimeout(async () => {
  try {
    const j = await listing(await lwa());
    const s = Array.isArray(j?.summaries) ? j.summaries[0] || {} : {};
    const statuses = Array.isArray(s?.status) ? s.status.map(String) : [];
    const issues = Array.isArray(j?.issues) ? j.issues : [];
    const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
    const target = j?.attributes?.[T.attributeName];
    const out = {
      status: "CF_SV8_100238_POSTLIVE_AUDIT_COMPLETE",
      readOnly: true,
      sellerSku: T.sku,
      asin: String(s?.asin || ""),
      productType: String(s?.productType || ""),
      statuses,
      buyable: statuses.includes("BUYABLE"),
      discoverable: statuses.includes("DISCOVERABLE"),
      errorCount: errors.length,
      issue100238Present: errors.some(x => String(x?.code || "") === T.issueCode),
      targetSlotPresent: Array.isArray(target) && target.length > 0,
      targetSlotUrl: String(target?.[0]?.media_location || ""),
      errors: errors.map(x => ({ code: String(x?.code || ""), severity: String(x?.severity || ""), message: String(x?.message || "") })),
      pass: String(s?.asin || "") === T.asin && statuses.includes("BUYABLE") && statuses.includes("DISCOVERABLE") && errors.length === 0 && !(Array.isArray(target) && target.length > 0),
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      variationRelationWrites: 0,
      otherContentWrites: 0,
      externalChanges: 0,
    };
    console.log(`${TAG}=${JSON.stringify(out)}`);
  } catch (e) {
    console.error(`${ERR}=${JSON.stringify({ error: e?.message || String(e), readOnly: true, amazonPersistentWrites: 0, externalChanges: 0 })}`);
  }
}, 2500);
