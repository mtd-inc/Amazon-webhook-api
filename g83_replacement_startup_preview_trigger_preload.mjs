import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const VERSION = "2026-09-09-g83-replacement-startup-preview-trigger-v1.0.0";
const PATH = "/amazon/listing/g83-replacement-validation-preview";
const previousListen = express.application.listen;

express.application.listen = function (...args) {
  const server = previousListen.apply(this, args);
  const port = Number(process.env.PORT || 10000);
  const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
  setTimeout(async () => {
    try {
      if (!secret) throw new Error("AMAZON_STOCK_API_SECRET_MISSING");
      const r = await fetch(`http://127.0.0.1:${port}${PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-secret": secret
        },
        body: JSON.stringify({
          dryRun: true,
          ean256: "4595989934973",
          ean1tb: "4595989934980"
        })
      });
      const text = await r.text();
      console.log(`G83_REPLACEMENT_AUTO_PREVIEW_RESULT=${JSON.stringify({version:VERSION,httpStatus:r.status,body:text})}`);
    } catch (e) {
      console.error(`G83_REPLACEMENT_AUTO_PREVIEW_ERROR=${JSON.stringify({version:VERSION,error:e?.message||String(e)})}`);
    }
  }, 3500);
  return server;
};
