import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OutputConnector, SavedAnnotation } from "./types";

// Filename: <conv>__<annotator>__<iso>.json
// Append-only; load() picks the newest file for the given (conv, annotator) pair.
const PAIR_RE = /^([^_]+(?:_[^_]+)*?)__([^_]+(?:_[^_]+)*?)__/;
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

export class LocalOutputConnector implements OutputConnector {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private safe(s: string, label: string): string {
    if (!SAFE_TOKEN.test(s)) throw new Error(`invalid ${label}: ${s}`);
    return s;
  }

  async save(id: string, turns: SavedAnnotation, meta: { savedAt: string; annotator: string }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const stamp = meta.savedAt.replace(/[:.]/g, "-");
    const file = join(this.dir, `${this.safe(id, "id")}__${this.safe(meta.annotator, "annotator")}__${stamp}.json`);
    await Bun.write(file, JSON.stringify(turns, null, 2));
  }

  async load(id: string, annotator: string): Promise<SavedAnnotation | null> {
    try {
      const prefix = `${this.safe(id, "id")}__${this.safe(annotator, "annotator")}__`;
      const entries = await readdir(this.dir);
      const matches = entries
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .sort()
        .reverse();
      if (!matches[0]) return null;
      const arr = (await Bun.file(join(this.dir, matches[0])).json()) as unknown;
      if (!Array.isArray(arr)) return null;
      return arr.map((t: any) => ({
        start: Number(t.start),
        end: Number(t.end),
        transcript: String(t.transcript ?? t.text ?? ""),
      }));
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async listAnnotated(annotator: string): Promise<Set<string>> {
    try {
      const annot = this.safe(annotator, "annotator");
      const entries = await readdir(this.dir);
      const ids = new Set<string>();
      for (const f of entries) {
        if (!f.endsWith(".json")) continue;
        const m = f.match(PAIR_RE);
        if (m && m[2] === annot && m[1]) ids.add(m[1]);
      }
      return ids;
    } catch (err: any) {
      if (err?.code === "ENOENT") return new Set();
      throw err;
    }
  }
}
