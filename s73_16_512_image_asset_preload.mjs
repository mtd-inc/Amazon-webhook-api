import express from "express";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const MODULE_VERSION = "2026-09-22-s73-16-512-image-assets-v1.0.0";
const originalListen = express.application.listen;
const ASSETS = Object.freeze({
  "/assets/s73-16-512-pt01.png": new URL("./public/S73-16-512-1.png", import.meta.url),
  "/assets/s73-16-512-pt05.png": new URL("./public/s73-16-512-5.png", import.meta.url),
  "/assets/s73-16-512-pt06.png": new URL("./public/s73-16-512-2.png", import.meta.url),
});

const loaded = Object.fromEntries(
  Object.entries(ASSETS).map(([route, url]) => {
    const bytes = readFileSync(url);
    return [route, {
      bytes,
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
        res.type("image/png");
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
