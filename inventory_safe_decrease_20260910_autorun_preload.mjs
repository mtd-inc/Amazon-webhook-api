import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-g83-zero-cutover-preflight-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const UPDATE = "/amazon/stock/update";
const TARGETS = [
  { role: "LEGACY_SUB_256", sku: "g83-i5-11-8gb-ssd256", asin: "B0GN84QRCF", target: 0 },
  { role: "HEALTHY_CHILD_512", sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", target: 0 },
  { role: "RETIRED_BAD_256", sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", target: 0 },
  { role: "RETIRED_BAD_1TB", sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", target: 0 }
];
const REPLACEMENT = { sku: "g83-hs-i5-11g-8gb-ssd256-r1", asin: "B0HJ8L6KJY", expected: 18 };
const originalListen = express.application.listen;

async function post(port, path, secret, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-secret": secret },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { rawText: text }; }
  return { httpStatus: response.status, ok: response.ok, body: json };
}

function freshMap(resp) {
  return new Map((Array.isArray(resp?.body?.results) ? resp.body.results : []).map(x => [x?.sku, x]));
}

function previewValid(resp) {
  return Boolean(
    resp?.ok &&
    resp?.body?.ok === true &&
    resp?.body?.dryRun === true &&
    String(resp?.body?.result?.status || "") === "VALID"
  );
}

express.application.listen = function g83ZeroCutoverPreflight(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const allSkus = [...TARGETS.map(x => x.sku), REPLACEMENT.sku];
      const freshResp = await post(port, FRESH, secret, { skus: allSkus });
      if (!freshResp.ok || freshResp.body?.ok !== true) {
        throw new Error(`FRESH_PREFLIGHT_FAILED:${JSON.stringify(freshResp)}`);
      }
      const map = freshMap(freshResp);
      const replacementFresh = map.get(REPLACEMENT.sku) || null;
      const rows = [];

      for (const t of TARGETS) {
        const fresh = map.get(t.sku) || null;
        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        const preview = await post(port, UPDATE, secret, {
          sku: t.sku,
          quantity: t.target,
          dryRun: true,
          reservation: false
        });

        const freshIdentityOk = Boolean(fresh?.ok && fresh.asin === t.asin);
        const current = freshIdentityOk ? Number(fresh.availableQuantity) : null;
        const decreaseRequired = current !== null && current > t.target;
        const ordersClear = Boolean(
          orders.ok &&
          orders.body?.ok === true &&
          Number(orders.body?.totalMatchingOpenQty || 0) === 0
        );
        const validationOk = previewValid(preview);
        const readyForExplicitLiveApproval = Boolean(
          freshIdentityOk && decreaseRequired && ordersClear && validationOk
        );

        rows.push({
          ...t,
          fresh,
          ordersGate: {
            httpStatus: orders.httpStatus,
            ok: orders.ok && orders.body?.ok === true,
            matchingLineCount: Number(orders.body?.matchingLineCount || 0),
            totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
          },
          validationPreview: {
            httpStatus: preview.httpStatus,
            ok: preview.ok,
            bodyOk: preview.body?.ok === true,
            dryRun: preview.body?.dryRun === true,
            status: preview.body?.result?.status || null,
            submissionId: preview.body?.result?.submissionId || null,
            issues: preview.body?.result?.issues || []
          },
          readyForExplicitLiveApproval
        });
      }

      const allValidated = rows.every(r => r.readyForExplicitLiveApproval);
      console.log(`G83_ZERO_CUTOVER_PREFLIGHT=${JSON.stringify({
        status: allValidated ? "VALIDATION_4_OF_4_PASS" : "VALIDATION_REVIEW_REQUIRED",
        moduleVersion: VERSION,
        replacementGuard: {
          target: REPLACEMENT,
          fresh: replacementFresh,
          note: "Replacement 256 remains an increase requiring explicit approval before LIVE cutover. No replacement write performed."
        },
        rows,
        liveAllowed: false,
        liveBlockedReason: "EXPLICIT_USER_LIVE_APPROVAL_REQUIRED",
        readOnlyExceptValidationPreview: true,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    } catch (error) {
      console.error(`G83_ZERO_CUTOVER_PREFLIGHT_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        liveAllowed: false,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    }
  }, 5000);

  return server;
};
