import type {
  Conversation,
  ConversationMeta,
  InputConnector,
  IntervalsPayload,
  SourceTranscript,
  TurnsPayload,
} from "./types";

// Marker for errors that originated upstream (Modal). Lets the server pick a
// 502-style status and surface the underlying detail to the client.
export class UpstreamError extends Error {
  upstream = true as const;
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

type FetchOpts = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  tries?: number;
  label: string;
};

// Single attempt with a long per-attempt timeout. 4xx is returned as-is to the
// caller; auth/bad-id are real, not retryable. On 5xx or network error we
// surface a dismissable dialog and let the user manually re-click Load —
// preferable to a hidden 2× wait that can blow past Bun's idleTimeout.
async function fetchWithRetry(url: string, opts: FetchOpts): Promise<Response> {
  const { headers, timeoutMs = 600_000, tries = 1, label } = opts;
  let lastErr: UpstreamError | null = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      clearTimeout(timer);
      if (res.status < 500) return res;
      const snippet = await safeBodySnippet(res);
      lastErr = new UpstreamError(
        `${label} HTTP ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ""}`,
        res.status,
      );
    } catch (err: any) {
      clearTimeout(timer);
      const detail = err?.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : err?.message || String(err);
      lastErr = new UpstreamError(`${label} network error — ${detail}`);
    }
    if (attempt < tries) {
      const delay = 800 + Math.floor(Math.random() * 400);
      console.warn(`[annotate] ${lastErr.message}; retrying in ${delay}ms (attempt ${attempt + 1}/${tries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new UpstreamError(`${label} failed`);
}

async function safeBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

type Options = {
  baseUrl: string;
  cookie: string; // raw "annotation_auth=<hex>"
  maxConversations?: number;
  // Optional restriction: when set, list() filters out conversations whose
  // volume is not in this allowlist. Useful for multi-tenant safety.
  allowedVolumes?: string[];
};

type RawCombinedRow = {
  id: string;
  volume: string;
  group?: string;
  duration_seconds?: number;
  has_human_annotation?: boolean;
};

type CombinedResponse = {
  conversations: RawCombinedRow[];
  total_unannotated: number;
  total_annotated: number;
  total_all: number;
};

export class ModalInputConnector implements InputConnector {
  private baseUrl: string;
  private cookie: string;
  private maxConversations: number;
  private allowedVolumes?: Set<string>;

  constructor(opts: Options) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.cookie = opts.cookie;
    this.maxConversations = opts.maxConversations ?? 1000;
    this.allowedVolumes = opts.allowedVolumes?.length
      ? new Set(opts.allowedVolumes)
      : undefined;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { cookie: this.cookie, accept: "application/json", ...extra };
  }

  async list(): Promise<ConversationMeta[]> {
    const url = `${this.baseUrl}/api/conversations-combined`;
    const res = await fetchWithRetry(url, { headers: this.headers(), label: "conversations-combined" });
    if (!res.ok) {
      const body = await safeBodySnippet(res);
      throw new UpstreamError(
        `conversations-combined HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
        res.status,
      );
    }
    const data = (await res.json()) as CombinedResponse;
    const rows = data.conversations.filter(
      (r) => !this.allowedVolumes || this.allowedVolumes.has(r.volume),
    );
    return rows.slice(0, this.maxConversations).map((r) => ({
      id: r.id,
      volume: r.volume,
      group: r.group,
      durationSeconds: r.duration_seconds,
      hasAnnotation: !!r.has_human_annotation,
    }));
  }

  async get(id: string, volume: string): Promise<Conversation> {
    const base = `${this.baseUrl}/api`;
    const headers = this.headers();
    const safeId = encodeURIComponent(id);
    const safeVol = encodeURIComponent(volume);

    const json = async <T,>(url: string, label: string): Promise<T> => {
      const r = await fetchWithRetry(url, { headers, label });
      if (!r.ok) {
        const body = await safeBodySnippet(r);
        throw new UpstreamError(
          `${label} HTTP ${r.status} ${r.statusText}${body ? ` — ${body}` : ""}`,
          r.status,
        );
      }
      return (await r.json()) as T;
    };

    // Upstream returns 404 when no human edits / turns exist yet — treat as empty.
    const jsonOrEmpty = async <T,>(url: string, label: string, empty: T): Promise<T> => {
      const r = await fetchWithRetry(url, { headers, label });
      if (r.status === 404) return empty;
      if (!r.ok) {
        const body = await safeBodySnippet(r);
        throw new UpstreamError(
          `${label} HTTP ${r.status} ${r.statusText}${body ? ` — ${body}` : ""}`,
          r.status,
        );
      }
      return (await r.json()) as T;
    };

    const [groundTruth, humanAnnotation, sourceTranscript, turnTranscripts] =
      await Promise.all([
        json<IntervalsPayload>(
          `${base}/intervals/${safeVol}/${safeId}/ground-truth`,
          "ground-truth",
        ),
        jsonOrEmpty<IntervalsPayload>(
          `${base}/intervals/${safeVol}/${safeId}/human-annotation`,
          "human-annotation",
          { intervals: [] },
        ),
        json<SourceTranscript>(
          `${base}/source-transcript/${safeVol}/${safeId}`,
          "source-transcript",
        ),
        jsonOrEmpty<TurnsPayload>(
          `${base}/turn-transcripts/${safeVol}/${safeId}`,
          "turn-transcripts",
          { turns: [] },
        ),
      ]);

    return {
      id,
      volume,
      // audioUrl is relative to our /nimbus-annotate/api mount; volume is
      // passed as a query param so the proxy can find it again.
      audioUrl: `audio/${safeId}?volume=${safeVol}`,
      groundTruth,
      humanAnnotation,
      sourceTranscript,
      turnTranscripts,
    };
  }

  async getAudio(id: string, volume: string, range?: string): Promise<Response> {
    const url = `${this.baseUrl}/api/audio/${encodeURIComponent(volume)}/${encodeURIComponent(id)}`;
    const headers: Record<string, string> = { cookie: this.cookie };
    if (range) headers.range = range;
    return fetchWithRetry(url, { headers, label: `audio ${id}` });
  }
}
