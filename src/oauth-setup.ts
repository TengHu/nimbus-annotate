/**
 * One-time OAuth setup for writing annotation files to My Drive folders.
 *
 * Why: service accounts can't write to My Drive (no quota). To upload files
 * owned by a real Google account, we need OAuth user credentials. Run this
 * script once to get a refresh token, paste it into .env, and you're done.
 *
 * Usage: bun run oauth-setup
 */

import { google } from "googleapis";
import { createServer } from "node:http";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.ANNOTATE_GDRIVE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.ANNOTATE_GDRIVE_OAUTH_CLIENT_SECRET;
const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;
const SCOPES = ["https://www.googleapis.com/auth/drive"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("✗ Missing OAuth client credentials.");
  console.error("  Add to .env:");
  console.error("    ANNOTATE_GDRIVE_OAUTH_CLIENT_ID=...apps.googleusercontent.com");
  console.error("    ANNOTATE_GDRIVE_OAUTH_CLIENT_SECRET=...");
  console.error("  Get them from Google Cloud Console → APIs & Services → Credentials.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",          // force consent screen — needed to get a refresh_token reliably
  scope: SCOPES,
});

console.log("\nOpening your browser to authorize Drive access…");
console.log("If it doesn't open automatically, paste this URL into your browser:\n");
console.log(authUrl);
console.log(`\nWaiting for callback on ${REDIRECT_URI} ...\n`);

const openCmd =
  process.platform === "darwin" ? "open" :
  process.platform === "win32"  ? "start" :
                                  "xdg-open";
exec(`${openCmd} "${authUrl}"`);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", REDIRECT_URI);
    if (url.pathname !== "/oauth-callback") {
      res.writeHead(404).end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (err) {
      res.writeHead(400, { "content-type": "text/html" }).end(
        `<h1>✗ OAuth error</h1><p>${err}</p><p>You can close this tab and try again.</p>`,
      );
      console.error(`✗ OAuth error: ${err}`);
      server.close();
      process.exit(1);
      return;
    }
    if (!code) {
      res.writeHead(400).end("missing ?code");
      return;
    }

    const { tokens } = await oauth2.getToken(code);

    res.writeHead(200, { "content-type": "text/html" }).end(
      `<!doctype html><meta charset="utf-8">
       <h1 style="font-family: sans-serif">✓ Authorized</h1>
       <p style="font-family: sans-serif">
         You can close this tab and return to your terminal.
       </p>`,
    );
    server.close();

    if (!tokens.refresh_token) {
      console.log("\n⚠ Google returned an access token but NO refresh token.");
      console.log("  This usually means you've already authorized this OAuth client before.");
      console.log("  Fix: revoke access at https://myaccount.google.com/permissions, then re-run.\n");
      process.exit(1);
    }

    console.log("\n✓ Got refresh token. Add this line to your .env:\n");
    console.log(`ANNOTATE_GDRIVE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log("Then restart `bun run dev` — saves will go to your Drive folder, owned by you.");
    process.exit(0);
  } catch (e: any) {
    res.writeHead(500).end("error");
    console.error("✗ Token exchange failed:", e?.message || e);
    process.exit(1);
  }
});

server.listen(PORT, () => {});
