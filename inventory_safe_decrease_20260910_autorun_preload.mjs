import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-10-inventory-backlog-audit-v1.0.0";
const FRESH = "/amazon/stock/fresh-get";
const ORDERS = "/amazon/orders/fresh-gate";
const UPDATE = "/amazon/stock/update";

// Remaining inventory mismatches that were previously blocked by listing/price errors.
// SSOT values are from 03_EC連携用在庫 immediately before this audit.
const TARGETS = [
  {
    role: "CF_SV8_512",
    sku: "cf-sv8-i5-8gb-ssd512",
    asin: "B0GH7GWDVP",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "通常",
    reservation: false
  },
  {
    role: "CF_SV8_1TB",
    sku: "cf-sv8-i5-8gb-ssd1",
    asin: "B0GH7CDB3Y",
    expected: 0,
    mappingEnabled: true,
    inventoryMode: "通常",
    reservation: false
  },
  {
    role: "CF_SV9_CANONICAL_512",
    sku: "cf-sv9-i5-8gb-ssd512",
    asin: "B0GJDLCYYH",
    expected: 7,
    mappingEnabled: true,
    inventoryMode: "共通在庫",
    reservation: false
  }
];

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
    String(resp?.body?.result?.status || "") === "VALID" &&
    Array.isArray(resp?.body?.result?.issues) &&
    resp.body.result.issues.length === 0
  );
}

express.application.listen = function inventoryBacklogAudit(...args) {
  const server = originalListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");

      const freshResp = await post(port, FRESH, secret, { skus: TARGETS.map(x => x.sku) });
      if (!freshResp.ok || freshResp.body?.ok !== true) {
        throw new Error(`FRESH_AUDIT_FAILED:${JSON.stringify(freshResp)}`);
      }
      const map = freshMap(freshResp);
      const rows = [];

      for (const t of TARGETS) {
        const fresh = map.get(t.sku) || null;
        const orders = await post(port, ORDERS, secret, { skus: [t.sku], lookbackHours: 168 });
        const ordersGate = {
          httpStatus: orders.httpStatus,
          ok: orders.ok && orders.body?.ok === true,
          matchingLineCount: Number(orders.body?.matchingLineCount || 0),
          totalMatchingOpenQty: Number(orders.body?.totalMatchingOpenQty || 0)
        };

        const identityExact = Boolean(fresh?.ok && fresh.asin === t.asin);
        const current = Number(fresh?.availableQuantity);
        const errorCount = Number(fresh?.errorCount);
        let action = "REVIEW";
        if (!identityExact) action = "IDENTITY_BLOCK";
        else if (!Number.isFinite(current)) action = "QUANTITY_BLOCK";
        else if (current === t.expected) action = "NO_CHANGE";
        else if (errorCount > 0) action = "BLOCK_LISTING_ERROR";
        else if (current > t.expected) action = "SAFE_DECREASE_CANDIDATE";
        else action = "REVIEW_INCREASE";

        let validationPreview = null;
        if (
          action === "SAFE_DECREASE_CANDIDATE" &&
          ordersGate.ok === true &&
          ordersGate.totalMatchingOpenQty === 0
        ) {
          const preview = await post(port, UPDATE, secret, {
            sku: t.sku,
            quantity: t.expected,
            dryRun: true,
            reservation: false
          });
          validationPreview = {
            httpStatus: preview.httpStatus,
            ok: preview.ok,
            status: preview.body?.result?.status || null,
            submissionId: preview.body?.result?.submissionId || null,
            issues: preview.body?.result?.issues || [],
            valid: previewValid(preview)
          };
          if (!validationPreview.valid) action = "VALIDATION_BLOCK";
        }

        rows.push({
          role: t.role,
          sku: t.sku,
          asin: t.asin,
          ssotExpected: t.expected,
          mappingEnabled: t.mappingEnabled,
          inventoryMode: t.inventoryMode,
          fresh,
          ordersGate,
          validationPreview,
          action
        });
      }

      const readyForApproval = rows.filter(x => x.action === "SAFE_DECREASE_CANDIDATE" && x.validationPreview?.valid === true);
      console.log(`INVENTORY_BACKLOG_AUDIT_RESULT=${JSON.stringify({
        status: "AUDIT_COMPLETE",
        moduleVersion: VERSION,
        rows,
        readyForExplicitLiveApproval: readyForApproval.map(x => ({
          sku: x.sku,
          asin: x.asin,
          from: Number(x.fresh?.availableQuantity),
          to: x.ssotExpected,
          validationSubmissionId: x.validationPreview?.submissionId || null
        })),
        liveAllowed: false,
        liveBlockedReason: "EXPLICIT_USER_LIVE_APPROVAL_REQUIRED",
        readOnlyExceptValidationPreview: true,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationWrites: 0,
        contentWrites: 0
      })}`);
    } catch (error) {
      console.error(`INVENTORY_BACKLOG_AUDIT_ERROR=${JSON.stringify({
        moduleVersion: VERSION,
        error: error?.message || String(error),
        liveAllowed: false,
        amazonInventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        variationWrites: 0,
        contentWrites: 0
      })}`);
    }
  }, 5000);

  return server;
};
