import { TARGET } from "./search_intelligence_generic_keyword_live_core.mjs";

const REGION_ENDPOINT = "https://sellingpartnerapi-fe.amazon.com";
const JP_MARKETPLACE = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";

export function buildSpApiRequest({ endpoint = REGION_ENDPOINT, sellerId, sku, accessToken, mode, patches }) {
  const base = String(endpoint || "").replace(/\/$/, "");
  if (base !== REGION_ENDPOINT) throw Error("UNTRUSTED_SPAPI_ENDPOINT");
  if (typeof sellerId !== "string" || !sellerId.trim() ||
      typeof accessToken !== "string" || !accessToken.trim()) throw Error("SPAPI_CREDENTIAL_REQUIRED");
  if (sku !== TARGET.sku) throw Error("SPAPI_TARGET_SKU_DRIFT");
  if (!["GET", "PREVIEW", "LIVE"].includes(mode)) throw Error("SPAPI_MODE_INVALID");

  const url = new URL("/listings/2021-08-01/items/" +
    encodeURIComponent(sellerId) + "/" + encodeURIComponent(sku), base);
  url.searchParams.set("marketplaceIds", JP_MARKETPLACE);
  url.searchParams.set("issueLocale", "ja_JP");
  const headers = { "x-amz-access-token": accessToken, accept: "application/json" };
  if (mode === "GET") {
    url.searchParams.set("includedData", "summaries,attributes,issues");
    return { url: url.toString(), options: { method: "GET", headers } };
  }

  if (!Array.isArray(patches) || patches.length !== 1 ||
      patches[0]?.op !== "replace" ||
      patches[0]?.path !== "/attributes/generic_keyword" ||
      !Array.isArray(patches[0]?.value) || patches[0].value.length !== 1 ||
      patches[0].value[0]?.value !== TARGET.proposed) throw Error("SPAPI_PATCH_SCOPE_INVALID");
  if (mode === "PREVIEW") url.searchParams.set("mode", "VALIDATION_PREVIEW");
  return {
    url: url.toString(),
    options: {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ productType: PRODUCT_TYPE, patches }),
    },
  };
}
