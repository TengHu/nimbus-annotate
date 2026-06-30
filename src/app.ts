import { Hono } from "hono";
import { join } from "node:path";
import { makeInputConnector, makeOutputConnector } from "./connectors";
import type { SavedAnnotation } from "./connectors/types";

const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;

// Map a thrown error to an HTTP status. UpstreamError carries an `upstream`
// flag (see modal-input.ts) — we surface those as 502 Bad Gateway with the
// original detail in the message, so the client toast shows the real cause.
const upstreamStatus = (err: any): 500 | 502 => (err?.upstream ? 502 : 500);

export function createAnnotateApp() {
  const input = makeInputConnector();
  const output = makeOutputConnector();
  const app = new Hono();

  // Normalize an ?annotator=… query param to a filename-safe token.
  // Default to "anyone" when missing — keeps the system usable without URL setup.
  const normAnnotator = (c: any): string => {
    const raw = (c.req.query("annotator") || "anyone").trim();
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
    return safe || "anyone";
  };

  app.get("/api/conversations", async (c) => {
    const annotator = normAnnotator(c);
    try {
      const [metas, locallyAnnotated] = await Promise.all([
        input.list(),
        output.listAnnotated(annotator),
      ]);
      return c.json(
        metas.map((m) => ({
          id: m.id,
          volume: m.volume,
          group: m.group,
          durationSeconds: m.durationSeconds,
          hasAnnotation: m.hasAnnotation || locallyAnnotated.has(m.id),
        })),
      );
    } catch (err: any) {
      console.error("[annotate] list error:", err);
      return c.json({ error: err.message || "list failed" }, upstreamStatus(err));
    }
  });

  app.get("/api/conversation/:id", async (c) => {
    const id = c.req.param("id");
    const volume = c.req.query("volume");
    if (!volume) return c.json({ error: "volume query param required" }, 400);
    const annotator = normAnnotator(c);
    try {
      const [conv, existing] = await Promise.all([
        input.get(id, volume),
        output.load(id, annotator),
      ]);
      return c.json({ ...conv, annotation: existing });
    } catch (err: any) {
      console.error("[annotate] get error:", err);
      return c.json({ error: err.message || "get failed" }, upstreamStatus(err));
    }
  });

  app.put("/api/annotation/:id", async (c) => {
    const id = c.req.param("id");
    const annotator = normAnnotator(c);
    try {
      const body = (await c.req.json()) as unknown;
      if (!Array.isArray(body)) {
        return c.json({ error: "body must be an array of {start, end, transcript}" }, 400);
      }
      const turns: SavedAnnotation = (body as any[]).map((t) => ({
        start: Number(t.start),
        end: Number(t.end),
        transcript: String(t.transcript ?? t.text ?? ""),
      }));
      const savedAt = new Date().toISOString();
      await output.save(id, turns, { savedAt, annotator });
      return c.json({ ok: true, savedAt, annotator });
    } catch (err: any) {
      console.error("[annotate] save error:", err);
      return c.json({ error: err.message || "save failed" }, 500);
    }
  });

  // Audio proxy: pipes upstream audio through our backend so the cookie stays
  // server-side and the browser can stream from the same origin.
  //
  // IMPORTANT: we buffer the body via .arrayBuffer() before responding, instead
  // of passing through the stream. Bun's Response strips Content-Length when
  // given a ReadableStream and falls back to Transfer-Encoding: chunked — and
  // without Content-Length the browser audio element can't compute duration on
  // initial load, so it shows the wrong/truncated time.
  app.get("/api/audio/:id", async (c) => {
    const id = c.req.param("id");
    const volume = c.req.query("volume");
    if (!volume) return c.json({ error: "volume query param required" }, 400);
    try {
      const upstream = await input.getAudio(id, volume, c.req.header("range"));
      const headers = new Headers();
      for (const h of [
        "content-type",
        "content-range",
        "accept-ranges",
        "cache-control",
      ]) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }
      const buf = await upstream.arrayBuffer();
      headers.set("content-length", String(buf.byteLength));
      return new Response(buf, { status: upstream.status, headers });
    } catch (err: any) {
      console.error("[annotate] audio proxy error:", err);
      return c.json({ error: err.message || "audio failed" }, upstreamStatus(err));
    }
  });

  const serveIndex = () =>
    new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  app.get("/", () => serveIndex());

  app.get("/:file{[A-Za-z0-9._-]+\\.[A-Za-z0-9]+}", async (c) => {
    const file = c.req.param("file");
    const f = Bun.file(join(PUBLIC_DIR, file));
    if (!(await f.exists())) return c.notFound();
    return new Response(f);
  });

  // Trailing-slash / SPA-style fallback: any path without a file extension
  // that isn't an /api/* call serves the index page.
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return c.text("Not Found", 404);
    if (c.req.path.includes(".")) return c.text("Not Found", 404);
    return serveIndex();
  });

  return app;
}
