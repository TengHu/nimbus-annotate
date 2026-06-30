import { Hono } from "hono";
import { createAnnotateApp } from "./app";

// Standalone entry for the annotation tool: the app owns the whole process
// and serves the UI plus its REST API from the root.
const app = new Hono();
app.route("/", createAnnotateApp());

export default {
  port: Number(process.env.PORT || 3000),
  // Disable the socket-level idle timeout so Modal cold starts (up to ~10min)
  // aren't cut off. The AbortController in connectors/modal-input.ts is the
  // real ceiling — nothing actually hangs forever.
  idleTimeout: 0,
  fetch: app.fetch,
};
