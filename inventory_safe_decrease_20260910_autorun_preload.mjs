import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-g83-zero-cutover-postlive-audit-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const TARGETS = [
  { role: "LEGACY_SUB_256", sku: "g83-i5-11-8gb-ssd256", asin: "B0GN84QRCF", target: 0, allowedIssueCodes: [] },
  { role: "HEALTHY_CHILD_512", sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", target: 0, allowedIssueCodes: [] },
  { role: "RETIRED_BAD_256", sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", target: 0, allowedIssueCodes: ["18653"] },
  { role: "RETIRED_BAD_1TB", sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", target: 0, allowedIssueCodes: ["18653"] }
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

function allowedIssues(t, row) {
  const codes = Array.isArray(row?.issueCodes) ? row.issueCodes.map(String) : [];
  return codes.every(code => t.allowedIssueCodes.includes(code));
}

express.application.listen = function g83ZeroPostLiveAudit(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");
      const allSkus = [...TARGETS.map(x => x.sku), REPLACEMENT.sku];
      const freshResp = await post(port, FRESH, secret, { skus: allSkus });
      const map = freshMap(freshResp);
      const rows = [];
      for (const t of TARGETS) {
        const fresh = map.get(t.sku) || null;
        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        const pass = Boolean(
          fresh?.ok && fresh.asin === t.asin && Number(fresh.availableQuantity) === 0 && allowedIssues(t, fresh) &&
          orders.ok && orders.body?.ok === true && Number(orders.body?.totalMatchingOpenQty || 0) === 0
        );
        rows.push({
          ...t,
          pass,
          fresh,
          ordersGate: {
            ok: orders.ok && orders.body?.ok === true,
            matchingLineCount: Number(orders.body?.matchingLineCount || 0),
            totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
          }
        });
      }
      const replacementFresh = map.get(REPLACEMENT.sku) || null;
      const replacementUntouched = Boolean(
        replacementFresh?.ok && replacementFresh.asin === REPLACEMENT.asin && Number(replacementFresh.availableQuantity) === 0 && Number(replacementFresh.errorCount) === 0
      );
      const pass = rows.every(x => x.pass) && replacementUntouched;
      console.log(`G83_ZERO_CUTOVER_POSTLIVE_AUDIT=${JSON.stringify({
        status: pass ? "G83_ZERO_4_OF_4_PASS" : "G83_ZERO_POSTLIVE_REVIEW_REQUIRED",
        moduleVersion: VERSION,
        rows,
        replacementGuard: { target: REPLACEMENT, fresh: replacementFresh, untouched: replacementUntouched },
        readOnly: true,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0
      })}`);
    } catch (error) {
      console.error(`G83_ZERO_CUTOVER_POSTLIVE_AUDIT_ERROR=${JSON.stringify({ moduleVersion: VERSION, error: error?.message || String(error), amazonInventoryWrites: 0, priceWrites: 0, b2bWrites: 0, adsWrites: 0, yahooWrites: 0 })}`);
    }
  }, 5000);
  return server;
};
