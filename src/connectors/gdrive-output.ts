import { google, type drive_v3 } from "googleapis";
import { Readable } from "node:stream";
import type { OutputConnector, SavedAnnotation } from "./types";

type Options = { folderId: string };

// GDrive output: each save uploads `<conv>__<annotator>__<iso>.json` whose
// body is the flat list [{start, end, transcript}, ...]. Append-only — multiple
// saves keep history; load(conv, annotator) picks the newest matching file.
const NAME_RE  = /^([^_]+(?:_[^_]+)*?)__([^_]+(?:_[^_]+)*?)__/;

export class GDriveOutputConnector implements OutputConnector {
  private drive: drive_v3.Drive;
  private folderId: string;

  constructor(opts: Options) {
    this.folderId = opts.folderId;
    const auth = makeGoogleAuth();
    this.drive = google.drive({ version: "v3", auth });
  }

  async save(id: string, turns: SavedAnnotation, meta: { savedAt: string; annotator: string }): Promise<void> {
    const stamp = meta.savedAt.replace(/[:.]/g, "-");
    const fileName = `${id}__${meta.annotator}__${stamp}.json`;
    const body = JSON.stringify(turns, null, 2);
    const res = await this.drive.files.create({
      requestBody: { name: fileName, parents: [this.folderId] },
      media: { mimeType: "application/json", body: Readable.from(body) },
      fields: "id, name, webViewLink, parents",
      supportsAllDrives: true,
    });
    console.log(
      `[annotate] gdrive upload ok: name=${res.data.name} id=${res.data.id} parents=${JSON.stringify(res.data.parents)} link=${res.data.webViewLink}`,
    );
  }

  async load(id: string, annotator: string): Promise<SavedAnnotation | null> {
    const prefix = `${id}__${annotator}__`;
    const res = await this.drive.files.list({
      q: `'${this.folderId}' in parents and trashed=false and mimeType='application/json' and name contains '${escapeQ(prefix)}'`,
      orderBy: "createdTime desc",
      pageSize: 50,
      fields: "files(id, name, createdTime)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const file = (res.data.files ?? []).find((f) => f.name?.startsWith(prefix));
    if (!file?.id) return null;
    const download = await this.drive.files.get(
      { fileId: file.id, alt: "media", supportsAllDrives: true },
      { responseType: "text" },
    );
    const arr = JSON.parse(download.data as unknown as string) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr.map((t: any) => ({
      start: Number(t.start),
      end: Number(t.end),
      transcript: String(t.transcript ?? t.text ?? ""),
    }));
  }

  async listAnnotated(annotator: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${this.folderId}' in parents and trashed=false and mimeType='application/json'`,
        fields: "nextPageToken, files(name)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files ?? []) {
        const m = f.name?.match(NAME_RE);
        if (m && m[2] === annotator && m[1]) ids.add(m[1]);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }
}

function makeGoogleAuth() {
  const scopes = ["https://www.googleapis.com/auth/drive"];

  // Prefer OAuth user credentials. Service accounts can't write to My Drive
  // folders (no storage quota), so when the user wants files owned by a real
  // Google account in a regular Drive folder, we use a refresh token issued
  // via `bun run oauth-setup`.
  const refreshToken = process.env.ANNOTATE_GDRIVE_OAUTH_REFRESH_TOKEN;
  const clientId     = process.env.ANNOTATE_GDRIVE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ANNOTATE_GDRIVE_OAUTH_CLIENT_SECRET;
  if (refreshToken && clientId && clientSecret) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }

  // Fall back to service account (Shared Drive folders only).
  const credJson = process.env.GOOGLE_CREDENTIALS_JSON;
  if (credJson) {
    const credentials = JSON.parse(credJson);
    return new google.auth.GoogleAuth({ credentials, scopes });
  }
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) {
    throw new Error(
      "Need either ANNOTATE_GDRIVE_OAUTH_REFRESH_TOKEN (+ client id/secret) or " +
      "GOOGLE_APPLICATION_CREDENTIALS for gdrive output.",
    );
  }
  return new google.auth.GoogleAuth({ keyFile: credPath, scopes });
}

function escapeQ(s: string) {
  return s.replace(/'/g, "\\'");
}
