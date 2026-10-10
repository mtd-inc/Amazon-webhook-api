import express from "express";

const WORKTREE_MARKER = "search-intelligence-live-20261008";
if (process.env.SI_STAGING_ISOLATED !== "YES" ||
    !process.cwd().toLowerCase().includes(WORKTREE_MARKER)) {
  throw Error("ISOLATED_STAGING_ONLY");
}
// Deliberately no Amazon credentials, Control Plane secrets, or external HTTP
// access are needed for this smoke service. It never enables a LIVE PATCH.
process.env.SI_GENERIC_KEYWORD_LIVE_ENABLED = "false";
await import("./search_intelligence_generic_keyword_live_preload.mjs");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "search-intelligence-isolated-staging",
  amazonLiveEnabled: false,
  externalWrites: 0,
}));
const port = 3194;
const server = app.listen(port, "127.0.0.1", () => {
  console.log("SI_STAGING_READY=127.0.0.1:" + port);
  console.log("AMAZON_LIVE_ENABLED=false");
  console.log("EXTERNAL_WRITES=0");
});
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
