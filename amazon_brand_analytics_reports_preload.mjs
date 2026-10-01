import express from "express";
import fetch from "node-fetch";
import { gunzipSync } from "node:zlib";
import "dotenv/config";

const MODULE_VERSION = "2026-10-01-brand-analytics-reports-v1.0.1";
const ROUTE_PREFIX = "/amazon/analytics/brand";
const REPORTS_API_VERSION = "2021-06-30";
const DEFAULT_MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 25000;
const DEFAULT_COLLECT_WAIT_SECONDS = 18;
const MAX_COLLECT_WAIT_SECONDS = 24;
const POLL_INTERVAL_MS = 2000;
const originalListen = express.application.listen;

const REPORT_TYPES = Object.freeze({
  SQP: "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT",
  SCP: "GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT",
});

function safeJsonParse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function getConfig() {
  return {
    clientId: String(process.env.LWA_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.LWA_CLIENT_SECRET || "").trim(),
    refreshToken: String(process.env.REFRESH_TOKEN || "").trim(),
    marketplaceId: String(process.env.SPAPI_MARKETPLACE_ID || DEFAULT_MARKETPLACE_ID).trim(),
    endpoint: String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, ""),
    sellerId: String(process.env.SPAPI_SELLER_ID || "").trim(),
  };
}

function getSecret() {
  return String(
    process.env.BRAND_ANALYTICS_API_SECRET ||
    process.env.AMAZON_STOCK_API_SECRET ||
    process.env.AMAZON_API_SECRET ||
    ""
  ).trim();
}

function requireSecret(req, res, next) {
  const expected = getSecret();
  if (!expected) {
    return res.status(500).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      readOnly: true,
      externalChanges: 0,
      error: "Brand Analytics API secret is not configured",
    });
  }
  const actual = String(req.headers["x-api-secret"] || "").trim();
  if (actual !== expected) {
    return res.status(401).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      readOnly: true,
      externalChanges: 0,
      error: "Unauthorized",
    });
  }
  return next();
}

function assertSpApiEnv() {
  const c = getConfig();
  const missing = [];
  if (!c.clientId) missing.push("LWA_CLIENT_ID");
  if (!c.clientSecret) missing.push("LWA_CLIENT_SECRET");
  if (!c.refreshToken) missing.push("REFRESH_TOKEN");
  if (!c.marketplaceId) missing.push("SPAPI_MARKETPLACE_ID");
  if (missing.length) throw new Error(`Missing env: ${missing.join(" / ")}`);
  return c;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getLwaAccessToken() {
  const c = assertSpApiEnv();
  const response = await fetchWithTimeout("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
    }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA_TOKEN_FAILED: HTTP ${response.status}`);
  }
  return json.access_token;
}

async function spApiRequest({ method, path, accessToken, body }) {
  const { endpoint } = assertSpApiEnv();
  const response = await fetchWithTimeout(`${endpoint}${path}`, {
    method,
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = safeJsonParse(text);
  if (!response.ok) {
    const err = new Error(`SP_API_HTTP_${response.status}: ${JSON.stringify(json).slice(0, 1200)}`);
    err.httpStatus = response.status;
    throw err;
  }
  return json;
}

function isoDateOnly(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const d = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) throw new Error(`${label} invalid date`);
  return { text, date: d };
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function latestCompletedWeekJst() {
  const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const localMidnightUtc = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ));
  let daysSinceSaturday = (localMidnightUtc.getUTCDay() + 1) % 7;
  if (daysSinceSaturday === 0) daysSinceSaturday = 7;
  const end = new Date(localMidnightUtc.getTime() - daysSinceSaturday * 86400000);
  const start = new Date(end.getTime() - 6 * 86400000);
  return { dataStartDate: formatDate(start), dataEndDate: formatDate(end) };
}

function normalizeAsins(value) {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const asins = [...new Set(raw.map(v => String(v || "").trim().toUpperCase()).filter(Boolean))];
  for (const asin of asins) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`Invalid ASIN: ${asin}`);
  }
  if (asins.join(" ").length > 200) throw new Error("ASIN list exceeds 200-character reportOptions limit");
  return asins;
}

function resolvePeriod(body = {}) {
  const period = String(body.reportPeriod || "WEEK").trim().toUpperCase();
  if (period !== "WEEK") throw new Error("Phase 1 supports reportPeriod=WEEK only");

  let dataStartDate = String(body.dataStartDate || "").trim();
  let dataEndDate = String(body.dataEndDate || "").trim();
  if (!dataStartDate && !dataEndDate) {
    ({ dataStartDate, dataEndDate } = latestCompletedWeekJst());
  }
  const start = isoDateOnly(dataStartDate, "dataStartDate");
  const end = isoDateOnly(dataEndDate, "dataEndDate");
  if (start.date.getUTCDay() !== 0) throw new Error("WEEK dataStartDate must be Sunday");
  if (end.date.getUTCDay() !== 6) throw new Error("WEEK dataEndDate must be Saturday");
  if ((end.date.getTime() - start.date.getTime()) !== 6 * 86400000) {
    throw new Error("WEEK request must cover exactly one Sunday-Saturday period");
  }
  return {
    reportPeriod: period,
    dataStartDate: start.text,
    dataEndDate: end.text,
    dataStartTime: `${start.text}T00:00:00Z`,
    dataEndTime: `${end.text}T23:59:59Z`,
  };
}

function reportKind(value) {
  const kind = String(value || "").trim().toUpperCase();
  if (!REPORT_TYPES[kind]) throw new Error("kind must be SQP or SCP");
  return kind;
}

async function createAnalyticsReport({ kind, period, asins }) {
  const c = assertSpApiEnv();
  const accessToken = await getLwaAccessToken();
  const reportOptions = { reportPeriod: period.reportPeriod };
  if (kind === "SQP" && asins.length) reportOptions.asins = asins.join(" ");

  const requestBody = {
    reportType: REPORT_TYPES[kind],
    marketplaceIds: [c.marketplaceId],
    dataStartTime: period.dataStartTime,
    dataEndTime: period.dataEndTime,
    reportOptions,
  };
  const json = await spApiRequest({
    method: "POST",
    path: `/reports/${REPORTS_API_VERSION}/reports`,
    accessToken,
    body: requestBody,
  });
  if (!json.reportId) throw new Error("SP_API_REPORT_ID_MISSING");
  return {
    reportId: String(json.reportId),
    requestBody,
  };
}

async function getReport(reportId, accessToken = null) {
  const token = accessToken || await getLwaAccessToken();
  return spApiRequest({
    method: "GET",
    path: `/reports/${REPORTS_API_VERSION}/reports/${encodeURIComponent(reportId)}`,
    accessToken: token,
  });
}

async function getReportDocumentMeta(reportDocumentId, accessToken = null) {
  const token = accessToken || await getLwaAccessToken();
  return spApiRequest({
    method: "GET",
    path: `/reports/${REPORTS_API_VERSION}/documents/${encodeURIComponent(reportDocumentId)}`,
    accessToken: token,
  });
}

async function downloadReportDocument(meta) {
  const url = String(meta?.url || "").trim();
  if (!url) throw new Error("REPORT_DOCUMENT_URL_MISSING");
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) throw new Error(`REPORT_DOCUMENT_DOWNLOAD_FAILED: HTTP ${response.status}`);
  let buffer = Buffer.from(await response.arrayBuffer());
  if (String(meta?.compressionAlgorithm || "").toUpperCase() === "GZIP") {
    buffer = gunzipSync(buffer);
  }
  const text = buffer.toString("utf8");
  const data = safeJsonParse(text);
  if (data?.rawText !== undefined) {
    throw new Error("REPORT_DOCUMENT_JSON_PARSE_FAILED");
  }
  return data;
}

function countReportRows(data) {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== "object") return 0;
  for (const key of [
    "dataByAsin",
    "dataByDepartmentAndSearchQuery",
    "searchQueryPerformance",
    "searchCatalogPerformance",
    "data",
  ]) {
    if (Array.isArray(data[key])) return data[key].length;
  }
  return null;
}

async function pollUntilTerminal(reportId, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  const accessToken = await getLwaAccessToken();
  let report = await getReport(reportId, accessToken);
  while (!["DONE", "CANCELLED", "FATAL"].includes(String(report.processingStatus || "").toUpperCase())) {
    if (Date.now() + POLL_INTERVAL_MS > deadline) break;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    report = await getReport(reportId, accessToken);
  }
  return report;
}

async function collect(kind, body) {
  const period = resolvePeriod(body);
  const asins = normalizeAsins(body.asins);
  const maxWaitSeconds = Math.max(
    0,
    Math.min(
      MAX_COLLECT_WAIT_SECONDS,
      Number.isFinite(Number(body.maxWaitSeconds))
        ? Number(body.maxWaitSeconds)
        : DEFAULT_COLLECT_WAIT_SECONDS
    )
  );

  const created = await createAnalyticsReport({ kind, period, asins });
  const report = await pollUntilTerminal(created.reportId, maxWaitSeconds);
  const status = String(report.processingStatus || "").toUpperCase();

  if (status === "FATAL") {
    let fatalDocument = null;
    let fatalDocumentError = "";
    if (report.reportDocumentId) {
      try {
        const accessToken = await getLwaAccessToken();
        const meta = await getReportDocumentMeta(report.reportDocumentId, accessToken);
        fatalDocument = await downloadReportDocument(meta);
      } catch (err) {
        fatalDocumentError = safeError(err).message;
      }
    }
    return {
      httpStatus: 422,
      payload: {
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: `${ROUTE_PREFIX}/${kind.toLowerCase()}/collect`,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        kind,
        reportType: REPORT_TYPES[kind],
        reportId: created.reportId,
        reportDocumentId: report.reportDocumentId || "",
        processingStatus: status,
        dataStartDate: period.dataStartDate,
        dataEndDate: period.dataEndDate,
        reportPeriod: period.reportPeriod,
        asins,
        requestBody: created.requestBody,
        fatalDocument,
        fatalDocumentError,
      },
    };
  }

  if (status === "CANCELLED") {
    return {
      httpStatus: 200,
      payload: {
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: `${ROUTE_PREFIX}/${kind.toLowerCase()}/collect`,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        kind,
        reportType: REPORT_TYPES[kind],
        reportId: created.reportId,
        processingStatus: status,
        dataStartDate: period.dataStartDate,
        dataEndDate: period.dataEndDate,
        reportPeriod: period.reportPeriod,
        asins,
        rowCount: 0,
        data: [],
      },
    };
  }

  if (status !== "DONE") {
    return {
      httpStatus: 202,
      payload: {
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: `${ROUTE_PREFIX}/${kind.toLowerCase()}/collect`,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        kind,
        reportType: REPORT_TYPES[kind],
        reportId: created.reportId,
        processingStatus: status || "IN_PROGRESS",
        dataStartDate: period.dataStartDate,
        dataEndDate: period.dataEndDate,
        reportPeriod: period.reportPeriod,
        asins,
      },
    };
  }

  if (!report.reportDocumentId) throw new Error("DONE report missing reportDocumentId");
  const accessToken = await getLwaAccessToken();
  const meta = await getReportDocumentMeta(report.reportDocumentId, accessToken);
  const data = await downloadReportDocument(meta);
  return {
    httpStatus: 200,
    payload: {
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: `${ROUTE_PREFIX}/${kind.toLowerCase()}/collect`,
      readOnly: true,
      commerceMutations: 0,
      externalChanges: 0,
      kind,
      reportType: REPORT_TYPES[kind],
      reportId: created.reportId,
      reportDocumentId: report.reportDocumentId,
      processingStatus: status,
      dataStartDate: period.dataStartDate,
      dataEndDate: period.dataEndDate,
      reportPeriod: period.reportPeriod,
      asins,
      rowCount: countReportRows(data),
      data,
    },
  };
}

function safeError(err) {
  return {
    name: String(err?.name || "Error"),
    message: String(err?.message || err || "Unknown error").slice(0, 1800),
  };
}

function register(app) {
  app.get(`${ROUTE_PREFIX}/health`, (req, res) => {
    const c = getConfig();
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      readOnly: true,
      commerceMutations: 0,
      externalChanges: 0,
      marketplaceId: c.marketplaceId,
      lwaConfigured: Boolean(c.clientId && c.clientSecret && c.refreshToken),
      sellerConfigured: Boolean(c.sellerId),
      apiSecretConfigured: Boolean(getSecret()),
      supported: REPORT_TYPES,
      defaultPeriod: "WEEK",
      defaultWindow: latestCompletedWeekJst(),
    });
  });

  app.post(`${ROUTE_PREFIX}/reports/request`, requireSecret, async (req, res) => {
    try {
      const kind = reportKind(req.body?.kind);
      const period = resolvePeriod(req.body || {});
      const asins = normalizeAsins(req.body?.asins);
      const created = await createAnalyticsReport({ kind, period, asins });
      return res.status(202).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        kind,
        reportType: REPORT_TYPES[kind],
        reportId: created.reportId,
        dataStartDate: period.dataStartDate,
        dataEndDate: period.dataEndDate,
        reportPeriod: period.reportPeriod,
        asins,
      });
    } catch (err) {
      console.error("Brand Analytics report request error", safeError(err));
      return res.status(400).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        error: safeError(err).message,
      });
    }
  });

  app.get(`${ROUTE_PREFIX}/reports/:reportId`, requireSecret, async (req, res) => {
    try {
      const report = await getReport(String(req.params.reportId || "").trim());
      return res.status(status === "FATAL" ? 422 : 200).json({
        ok: status !== "FATAL",
        moduleVersion: MODULE_VERSION,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        report,
      });
    } catch (err) {
      console.error("Brand Analytics get report error", safeError(err));
      return res.status(400).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        error: safeError(err).message,
      });
    }
  });

  app.get(`${ROUTE_PREFIX}/reports/:reportId/document`, requireSecret, async (req, res) => {
    try {
      const report = await getReport(String(req.params.reportId || "").trim());
      const status = String(report.processingStatus || "").toUpperCase();
      if (status !== "DONE" && status !== "FATAL") {
        return res.status(202).json({
          ok: true,
          moduleVersion: MODULE_VERSION,
          readOnly: true,
          commerceMutations: 0,
          externalChanges: 0,
          processingStatus: status || "IN_PROGRESS",
          reportId: report.reportId || req.params.reportId,
        });
      }
      if (!report.reportDocumentId) {
        return res.status(status === "FATAL" ? 422 : 400).json({
          ok: status !== "FATAL",
          moduleVersion: MODULE_VERSION,
          readOnly: true,
          commerceMutations: 0,
          externalChanges: 0,
          processingStatus: status,
          reportId: report.reportId || req.params.reportId,
          error: status === "FATAL" ? "FATAL report has no reportDocumentId" : "DONE report missing reportDocumentId",
        });
      }
      const accessToken = await getLwaAccessToken();
      const meta = await getReportDocumentMeta(report.reportDocumentId, accessToken);
      const data = await downloadReportDocument(meta);
      return res.status(200).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        processingStatus: status,
        reportId: report.reportId || req.params.reportId,
        reportDocumentId: report.reportDocumentId,
        rowCount: countReportRows(data),
        data,
      });
    } catch (err) {
      console.error("Brand Analytics report document error", safeError(err));
      return res.status(400).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        readOnly: true,
        commerceMutations: 0,
        externalChanges: 0,
        error: safeError(err).message,
      });
    }
  });

  for (const kind of ["SQP", "SCP"]) {
    app.post(`${ROUTE_PREFIX}/${kind.toLowerCase()}/collect`, requireSecret, async (req, res) => {
      try {
        const result = await collect(kind, req.body || {});
        return res.status(result.httpStatus).json(result.payload);
      } catch (err) {
        console.error(`Brand Analytics ${kind} collect error`, safeError(err));
        return res.status(400).json({
          ok: false,
          moduleVersion: MODULE_VERSION,
          readOnly: true,
          commerceMutations: 0,
          externalChanges: 0,
          kind,
          error: safeError(err).message,
        });
      }
    });
  }
}

express.application.listen = function brandAnalyticsReportsListen(...args) {
  const healthPath = `${ROUTE_PREFIX}/health`;
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === healthPath)
  );
  if (!alreadyRegistered) register(this);
  return originalListen.apply(this, args);
};
