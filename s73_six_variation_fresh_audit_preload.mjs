import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-s73-six-variation-fresh-audit-v1.0.0";
const TAG = "S73_SIX_VARIATION_FRESH_AUDIT_RESULT";
const ERR = "S73_SIX_VARIATION_FRESH_AUDIT_ERROR";
const MP = "A1VC38T7YXB528";
const PT = "NOTEBOOK_COMPUTER";
const COMBINED_THEME = "HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";

const CURRENT = Object.freeze([
  Object.freeze({ role: "PARENT", sku: "s73-hs-i5-11g-16gb-storage-parent", asin: "B0HJ265LZ6" }),
  Object.freeze({ role: "CHILD_16_256", sku: "7X-725F-2ZML", asin: "B0HGDBYRS8", ramGB: 16, storageGB: 256 }),
  Object.freeze({ role: "CHILD_16_512", sku: "s73-hs-i5-11g-16gb-ssd512", asin: "B0HJ28YCP7", ramGB: 16, storageGB: 512 }),
]);

const CANDIDATE_SKUS = Object.freeze([
  "s73-i5-11g-8gb-ssd256",
  "s73-hs-i5-11g-8gb-ssd256",
  "s73-hs-i5-11g-8gb-ssd512",
  "s73-hs-i5-11g-8gb-ssd1tb",
  "s73-hs-i5-11g-16gb-ssd1tb",
]);

const parse = t => { try { return t ? JSON.parse(t) : {}; } catch { return { rawText: String(t).slice(0, 3000) }; } };

function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MP).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("SELLER_ID_MISSING");
  if (marketplaceId !== MP) throw new Error(`MARKETPLACE_MISMATCH:${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function lwa() {
  const { LWA_CLIENT_ID: client_id, LWA_CLIENT_SECRET: client_secret, REFRESH_TOKEN: refresh_token } = process.env;
  if (!client_id || !client_secret || !refresh_token) throw new Error("LWA_ENV_MISSING");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id, client_secret }),
  });
  const j = parse(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA_FAILED:${r.status}`);
  return j.access_token;
}

async function getListing(a, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues",
    issueLocale: "ja_JP",
  });
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, {
    headers: { "x-amz-access-token": a, accept: "application/json" },
  });
  const body = parse(await r.text());
  return { httpStatus: r.status, ok: r.ok, body };
}

async function getCatalog(a, asin) {
  const { marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "relationships,summaries,productTypes" });
  const r = await fetch(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`, {
    headers: { "x-amz-access-token": a, accept: "application/json" },
  });
  return { httpStatus: r.status, ok: r.ok, body: parse(await r.text()) };
}

async function getPtd(a) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ sellerId, marketplaceIds: marketplaceId, requirements: "LISTING", requirementsEnforced: "ENFORCED", locale: "ja_JP" });
  const d = await fetch(`${endpoint}/definitions/2020-09-01/productTypes/${PT}?${q}`, { headers: { "x-amz-access-token": a, accept: "application/json" } });
  const dj = parse(await d.text());
  if (!d.ok) throw new Error(`PTD_DEFINITION_FAILED:${d.status}`);
  const u = String(dj?.schema?.link?.resource || "");
  if (!u) throw new Error("PTD_SCHEMA_LINK_MISSING");
  const r = await fetch(u, { headers: { accept: "application/json" } });
  const j = parse(await r.text());
  if (!r.ok) throw new Error(`PTD_SCHEMA_FAILED:${r.status}`);
  return j;
}

function collectEnums(node, depth = 0, out = []) {
  if (!node || typeof node !== "object" || depth > 8) return out;
  if (Array.isArray(node)) { node.forEach(x => collectEnums(x, depth + 1, out)); return out; }
  if (Array.isArray(node.enum)) node.enum.forEach(v => out.push(v));
  if (node.const !== undefined) out.push(node.const);
  for (const k of ["items", "properties", "oneOf", "anyOf", "allOf"]) collectEnums(node[k], depth + 1, out);
  return out;
}

function ptdInfo(schema) {
  const themeSpec = schema?.properties?.variation_theme?.items?.properties?.name;
  const raw = [...new Set(collectEnums(themeSpec).map(String))];
  return {
    combinedThemeSupported: raw.includes(COMBINED_THEME),
    relevantThemes: raw.filter(x => /HARD_DISK_SIZE/.test(x) && /(RAM|MEMORY)/i.test(x)),
  };
}

function first(rows, key = "value") { return Array.isArray(rows) && rows[0] ? rows[0]?.[key] ?? null : null; }
function nested(rows, key) { return Array.isArray(rows) && rows[0] && Array.isArray(rows[0]?.[key]) && rows[0][key][0] ? rows[0][key][0]?.value ?? null : null; }

function snapshot(row, response) {
  if (!response.ok) return { ...row, exists: false, httpStatus: response.httpStatus, error: response.body };
  const b = response.body;
  const s = Array.isArray(b?.summaries) ? b.summaries[0] || {} : {};
  const a = b?.attributes || {};
  const issues = Array.isArray(b?.issues) ? b.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  return {
    ...row,
    exists: true,
    httpStatus: response.httpStatus,
    actualAsin: String(s?.asin || ""),
    asinMatches: !row.asin || String(s?.asin || "") === row.asin,
    productType: String(s?.productType || ""),
    title: String(s?.itemName || first(a?.item_name) || ""),
    statuses: Array.isArray(s?.status) ? s.status : [],
    parentage: first(a?.parentage_level),
    parentSku: first(a?.child_parent_sku_relationship, "parent_sku"),
    relationship: first(a?.child_parent_sku_relationship, "child_relationship_type"),
    theme: first(a?.variation_theme, "name"),
    ramGB: nested(a?.ram_memory, "installed_size"),
    hardDiskGB: nested(a?.hard_disk, "size"),
    flashMemoryGB: nested(a?.flash_memory, "installed_size"),
    errorCount: errors.length,
    issueCodes: [...new Set(errors.map(x => String(x?.code || "")).filter(Boolean))],
  };
}

async function themePreview(a, sku, isParent) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const patches = [{ op: "replace", path: "/attributes/variation_theme", value: [{ name: COMBINED_THEME }] }];
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues", mode: "VALIDATION_PREVIEW" });
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, {
    method: "PATCH",
    headers: { "x-amz-access-token": a, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ productType: PT, patches }),
  });
  const body = parse(await r.text());
  const issues = Array.isArray(body?.issues) ? body.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const status = String(body?.status || "").toUpperCase();
  return {
    sku,
    role: isParent ? "PARENT" : "CHILD",
    httpStatus: r.status,
    responseOk: r.ok,
    status,
    submissionId: String(body?.submissionId || ""),
    errorCount: errors.length,
    issueCodes: [...new Set(errors.map(x => String(x?.code || "")).filter(Boolean))],
    issues,
    valid: r.ok && errors.length === 0 && ["VALID", "ACCEPTED"].includes(status),
  };
}

async function run() {
  const a = await lwa();
  const schema = await getPtd(a);
  const ptd = ptdInfo(schema);
  const current = [];
  for (const row of CURRENT) current.push(snapshot(row, await getListing(a, row.sku)));

  const candidateSkuProbe = [];
  for (const sku of CANDIDATE_SKUS) candidateSkuProbe.push(snapshot({ role: "CANDIDATE_SKU_PROBE", sku }, await getListing(a, sku)));

  const parent = current.find(x => x.role === "PARENT");
  const child256 = current.find(x => x.role === "CHILD_16_256");
  const child512 = current.find(x => x.role === "CHILD_16_512");
  const blockers = [];
  if (!ptd.combinedThemeSupported) blockers.push("COMBINED_THEME_NOT_SUPPORTED");
  for (const x of current) {
    if (!x.exists) blockers.push(`${x.role}_MISSING`);
    if (x.exists && x.asin && !x.asinMatches) blockers.push(`${x.role}_ASIN_MISMATCH`);
    if (x.exists && x.productType !== PT) blockers.push(`${x.role}_PRODUCT_TYPE_MISMATCH`);
    if (x.exists && x.errorCount > 0) blockers.push(`${x.role}_HAS_LISTING_ERROR`);
  }
  if (child256?.ramGB !== 16 || child256?.hardDiskGB !== 256) blockers.push("CHILD_16_256_SPEC_MISMATCH");
  if (child512?.ramGB !== 16 || child512?.hardDiskGB !== 512) blockers.push("CHILD_16_512_SPEC_MISMATCH");

  const catalog = parent?.actualAsin ? await getCatalog(a, parent.actualAsin) : null;
  const themePreviews = ptd.combinedThemeSupported && blockers.length === 0 ? [
    await themePreview(a, parent.sku, true),
    await themePreview(a, child256.sku, false),
    await themePreview(a, child512.sku, false),
  ] : [];

  const themeMigrationPreviewPass = themePreviews.length === 3 && themePreviews.every(x => x.valid);

  const targetFamily = [
    { ramGB: 8, storageGB: 256, status: "NEW_CHILD_REQUIRED", proposedSellerSku: "s73-hs-i5-11g-8gb-ssd256" },
    { ramGB: 8, storageGB: 512, status: "NEW_CHILD_REQUIRED", proposedSellerSku: "s73-hs-i5-11g-8gb-ssd512" },
    { ramGB: 8, storageGB: 1024, status: "NEW_CHILD_REQUIRED", proposedSellerSku: "s73-hs-i5-11g-8gb-ssd1tb" },
    { ramGB: 16, storageGB: 256, status: "PRESERVE_EXISTING", sellerSku: "7X-725F-2ZML", asin: "B0HGDBYRS8" },
    { ramGB: 16, storageGB: 512, status: "PRESERVE_EXISTING", sellerSku: "s73-hs-i5-11g-16gb-ssd512", asin: "B0HJ28YCP7" },
    { ramGB: 16, storageGB: 1024, status: "NEW_CHILD_REQUIRED", proposedSellerSku: "s73-hs-i5-11g-16gb-ssd1tb" },
  ];

  console.log(`${TAG}=${JSON.stringify({
    status: blockers.length === 0 && themeMigrationPreviewPass ? "S73_SIX_VARIATION_PREFLIGHT_PASS" : "S73_SIX_VARIATION_REVIEW_REQUIRED",
    moduleVersion: VERSION,
    readOnlyFreshAudit: true,
    validationPreviewOnly: true,
    liveImplemented: false,
    marketplaceId: MP,
    productType: PT,
    current,
    currentParentCatalog: catalog ? { httpStatus: catalog.httpStatus, ok: catalog.ok, body: catalog.body } : null,
    productTypeDefinition: ptd,
    candidateSkuProbe,
    targetFamily,
    themeMigration: {
      currentTheme: "HARD_DISK_SIZE",
      targetTheme: COMBINED_THEME,
      previews: themePreviews,
      pass: themeMigrationPreviewPass,
    },
    blockers,
    nextRequirements: {
      newChildCount: 4,
      newGtinCount: 4,
      gtinSource: "GS1/GJDB allocation required before new child PUT previews",
      preserveExistingAsins: ["B0HGDBYRS8", "B0HJ28YCP7"],
      preserveParentAsin: "B0HJ265LZ6",
    },
    amazonPersistentWrites: 0,
    inventoryWrites: 0,
    priceWrites: 0,
    b2bWrites: 0,
    adsWrites: 0,
    yahooWrites: 0,
    externalChanges: 0,
  })}`);
}

setTimeout(() => run().catch(e => console.error(`${ERR}=${JSON.stringify({
  status: "FAILED",
  moduleVersion: VERSION,
  readOnlyFreshAudit: true,
  validationPreviewOnly: true,
  liveImplemented: false,
  error: e?.message || String(e),
  amazonPersistentWrites: 0,
  inventoryWrites: 0,
  priceWrites: 0,
  b2bWrites: 0,
  adsWrites: 0,
  yahooWrites: 0,
  externalChanges: 0,
})}`)), 3000);
