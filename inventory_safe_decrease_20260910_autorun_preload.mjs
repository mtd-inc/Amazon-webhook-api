import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-g83-zero-cutover-live-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const UPDATE = "/amazon/stock/update";
const TARGETS = [
  { role: "LEGACY_SUB_256", sku: "g83-i5-11-8gb-ssd256", asin: "B0GN84QRCF", before: 4, target: 0, allowedIssueCodes: [] },
  { role: "HEALTHY_CHILD_512", sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", before: 4, target: 0, allowedIssueCodes: [] },
  { role: "RETIRED_BAD_256", sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", before: 4, target: 0, allowedIssueCodes: ["18653"] },
  { role: "RETIRED_BAD_1TB", sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", before: 3, target: 0, allowedIssueCodes: ["18653"] }
];
const REPLACEMENT = { sku: "g83-hs-i5-11g-8gb-ssd256-r1", asin: "B0HJ8L6KJY", expected: 18 };
const originalListen = express.application.listen;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function issueGuard(t, row) {
  const codes = Array.isArray(row?.issueCodes) ? row.issueCodes.map(String) : [];
  return codes.every(code => t.allowedIssueCodes.includes(code));
}

function exactAt(t, row, qty) {
  return Boolean(row?.ok) &&
    row.asin === t.asin &&
    Number(row.availableQuantity) === qty &&
    issueGuard(t, row);
}

function previewValid(resp) {
  return Boolean(
    resp?.ok &&
    resp?.body?.ok === true &&
    resp?.body?.dryRun === true &&
    String(resp?.body?.result?.status || "") === "VALID"
  );
}

express.application.listen = function g83ZeroCutoverLive(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    let writes = 0;
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const allSkus = [...TARGETS.map(x => x.sku), REPLACEMENT.sku];
      const initialResp = await post(port, FRESH, secret, { skus: allSkus });
      if (!initialResp.ok || initialResp.body?.ok !== true) {
        throw new Error(`INITIAL_FRESH_FAILED:${JSON.stringify(initialResp)}`);
      }
      const initialMap = freshMap(initialResp);
      const replacementFresh = initialMap.get(REPLACEMENT.sku) || null;
      if (!replacementFresh?.ok || replacementFresh.asin !== REPLACEMENT.asin || Number(replacementFresh.availableQuantity) !== 0 || Number(replacementFresh.errorCount) !== 0) {
        throw new Error(`REPLACEMENT_GUARD_BLOCK:${JSON.stringify(replacementFresh)}`);
      }

      const preflight = [];
      for (const t of TARGETS) {
        const fresh = initialMap.get(t.sku) || null;
        if (exactAt(t, fresh, t.target)) {
          preflight.push({ sku: t.sku, state: "ALREADY_ZERO", fresh });
          continue;
        }
        if (!exactAt(t, fresh, t.before)) {
          throw new Error(`INITIAL_TARGET_GUARD_BLOCK:${t.sku}:${JSON.stringify(fresh)}`);
        }

        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        if (!orders.ok || orders.body?.ok !== true || Number(orders.body?.totalMatchingOpenQty || 0) !== 0) {
          throw new Error(`ORDERS_GATE_BLOCK:${t.sku}:${JSON.stringify(orders)}`);
        }

        const preview = await post(port, UPDATE, secret, { sku: t.sku, quantity: 0, dryRun: true, reservation: false });
        if (!previewValid(preview)) {
          throw new Error(`VALIDATION_PREVIEW_BLOCK:${t.sku}:${JSON.stringify(preview)}`);
        }
        preflight.push({
          sku: t.sku,
          state: "READY_LIVE_ZERO",
          fresh,
          ordersMatchingQty: Number(orders.body?.totalMatchingOpenQty || 0),
          previewSubmissionId: preview.body?.result?.submissionId || null
        });
        await sleep(250);
      }

      const live = [];
      for (const t of TARGETS) {
        const currentResp = await post(port, FRESH, secret, { skus: [t.sku] });
        const current = freshMap(currentResp).get(t.sku) || null;
        if (exactAt(t, current, t.target)) {
          live.push({ sku: t.sku, action: "PRESERVE_ALREADY_ZERO", target: 0 });
          continue;
        }
        if (!exactAt(t, current, t.before)) {
          throw new Error(`LAST_SECOND_GUARD_BLOCK:${t.sku}:${JSON.stringify(current)}`);
        }

        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        if (!orders.ok || orders.body?.ok !== true || Number(orders.body?.totalMatchingOpenQty || 0) !== 0) {
          throw new Error(`LAST_SECOND_ORDERS_BLOCK:${t.sku}:${JSON.stringify(orders)}`);
        }

        const response = await post(port, UPDATE, secret, { sku: t.sku, quantity: 0, dryRun: false, reservation: false });
        if (!response.ok || response.body?.ok !== true || response.body?.dryRun !== false || String(response.body?.result?.status || "") !== "ACCEPTED") {
          throw new Error(`LIVE_ZERO_BLOCK:${t.sku}:${JSON.stringify(response)}`);
        }
        writes += 1;
        live.push({
          sku: t.sku,
          action: "LIVE_ZERO",
          httpStatus: response.httpStatus,
          status: response.body?.result?.status || null,
          submissionId: response.body?.result?.submissionId || null
        });
        await sleep(600);
      }

      let finalMap = null;
      let allZero = false;
      for (let attempt = 1; attempt <= 15; attempt += 1) {
        const finalResp = await post(port, FRESH, secret, { skus: TARGETS.map(x => x.sku) });
        finalMap = freshMap(finalResp);
        allZero = TARGETS.every(t => exactAt(t, finalMap.get(t.sku), 0));
        if (allZero) break;
        await sleep(3000);
      }

      const final = TARGETS.map(t => ({
        sku: t.sku,
        asin: t.asin,
        target: 0,
        fresh: finalMap?.get(t.sku) || null
      }));

      console.log(`G83_ZERO_CUTOVER_LIVE_RESULT=${JSON.stringify({
        status: allZero ? "G83_ZERO_4_OF_4_PASS" : "G83_ZERO_POSTVERIFY_PENDING",
        moduleVersion: VERSION,
        replacementGuard: { target: REPLACEMENT, initialFresh: replacementFresh, untouched: true },
        preflight,
        live,
        final,
        amazonInventoryWrites: writes,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    } catch (error) {
      console.error(`G83_ZERO_CUTOVER_LIVE_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        amazonInventoryWrites: writes,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    }
  }, 5000);

  return server;
};
