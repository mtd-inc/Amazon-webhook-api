import express from "express";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const MODULE_VERSION = "2026-09-25-s73-variant-image-assets-v2.3.0";
const originalListen = express.application.listen;
const ASSETS = Object.freeze({
  "/assets/s73-16-512-pt01.png": { url: new URL("./public/S73-16-512-1.png", import.meta.url), type: "image/png" },
  "/assets/s73-16-512-pt05.png": { url: new URL("./public/s73-16-512-5.png", import.meta.url), type: "image/png" },
  "/assets/s73-16-512-pt06.png": { url: new URL("./public/s73-16-512-2.png", import.meta.url), type: "image/png" },
  "/assets/s73-8-256-main-v2.jpg": { url: new URL("./public/s73-8-256-main-v2.jpg", import.meta.url), type: "image/jpeg" },
  "/assets/s73-8-256-pt01-v2.jpg": { url: new URL("./public/s73-8-256-pt01-v2.jpg", import.meta.url), type: "image/jpeg" },
  "/assets/s73-8-256-pt05-v2.jpg": { url: new URL("./public/s73-8-256-pt05-v2.jpg", import.meta.url), type: "image/jpeg" },
  "/assets/s73-16-512-main-v3.png": { url: new URL("./public/s73-16-512-main-v3.png", import.meta.url), type: "image/png" },
  "/assets/s73-16-512-pt01-v3.png": { url: new URL("./public/s73-16-512-pt01-v3.png", import.meta.url), type: "image/png" },
  "/assets/s73-16-512-pt05-v3.png": { url: new URL("./public/s73-16-512-pt05-v3.png", import.meta.url), type: "image/png" },
  "/assets/s73-16-1tb-main-v1.jpg": { url: new URL("./public/s73-16-1tb-main-v1.jpg", import.meta.url), type: "image/jpeg" },
  "/assets/s73-16-1tb-pt01-v1.jpg": { url: new URL("./public/s73-16-1tb-pt01-v1.jpg", import.meta.url), type: "image/jpeg" },
  "/assets/s73-16-1tb-pt05-v1.jpg": { url: new URL("./public/s73-16-1tb-pt05-v1.jpg", import.meta.url), type: "image/jpeg" },
  "/assets/s73-shared-1tb-main-v2.png": { url: new URL("./public/s73-shared-1tb-main-v2.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-1tb-pt01-v2.png": { url: new URL("./public/s73-shared-1tb-pt01-v2.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-1tb-pt05-v2.png": { url: new URL("./public/s73-shared-1tb-pt05-v2.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-256-v1-main.png": { url: new URL("./public/s73-shared-256-v1-main.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-256-v1-pt01.png": { url: new URL("./public/s73-shared-256-v1-pt01.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-256-v1-pt05.png": { url: new URL("./public/s73-shared-256-v1-pt05.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-512-v1-main.png": { url: new URL("./public/s73-shared-512-v1-main.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-512-v1-pt01.png": { url: new URL("./public/s73-shared-512-v1-pt01.png", import.meta.url), type: "image/png" },
  "/assets/s73-shared-512-v1-pt05.png": { url: new URL("./public/s73-shared-512-v1-pt05.png", import.meta.url), type: "image/png" },
});

const loaded = Object.fromEntries(
  Object.entries(ASSETS).map(([route, spec]) => {
    const bytes = readFileSync(spec.url);
    return [route, {
      bytes,
      type: spec.type,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    }];
  })
);

express.application.listen = function s73ImageAssetListen(...args) {
  for (const [route, asset] of Object.entries(loaded)) {
    const exists = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === route));
    if (!exists) {
      this.get(route, (req, res) => {
        res.set("Cache-Control", "public, max-age=300");
        res.set("X-S73-Image-Version", MODULE_VERSION);
        res.set("X-Content-SHA256", asset.sha256);
        res.type(asset.type);
        return res.status(200).send(asset.bytes);
      });
    }
  }
  const server = originalListen.apply(this, args);
  setTimeout(() => {
    console.log("S73_16_512_IMAGE_ASSET_READY=" + JSON.stringify({
      moduleVersion: MODULE_VERSION,
      assets: Object.fromEntries(Object.entries(loaded).map(([route, asset]) => [
        route,
        { bytes: asset.bytes.length, sha256: asset.sha256 }
      ])),
      amazonPersistentWrites: 0,
    }));
  }, 1000);
  return server;
};
