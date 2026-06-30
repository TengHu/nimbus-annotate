import { DemoInputConnector } from "./demo-input";
import { GDriveOutputConnector } from "./gdrive-output";
import { LocalOutputConnector } from "./local-output";
import { ModalInputConnector } from "./modal-input";
import type { InputConnector, OutputConnector } from "./types";

export function makeInputConnector(): InputConnector {
  const kind = (process.env.ANNOTATE_INPUT || "modal").toLowerCase();
  if (kind === "demo") {
    // Self-contained sample data + generated audio — no backend required.
    return new DemoInputConnector();
  }
  if (kind === "modal") {
    const baseUrl = process.env.ANNOTATE_MODAL_BASE_URL;
    const cookie = process.env.ANNOTATE_MODAL_COOKIE;
    if (!baseUrl || !cookie) {
      throw new Error("ANNOTATE_MODAL_BASE_URL and ANNOTATE_MODAL_COOKIE required");
    }
    const maxConversations = process.env.ANNOTATE_MAX_CONVERSATIONS
      ? Number(process.env.ANNOTATE_MAX_CONVERSATIONS)
      : undefined;
    // Optional: comma-separated list of volumes to expose. When unset, all are shown.
    const allowedVolumes = process.env.ANNOTATE_MODAL_VOLUMES
      ? process.env.ANNOTATE_MODAL_VOLUMES.split(",").map((v) => v.trim()).filter(Boolean)
      : undefined;
    return new ModalInputConnector({ baseUrl, cookie, maxConversations, allowedVolumes });
  }
  throw new Error(`unknown ANNOTATE_INPUT: ${kind}`);
}

export function makeOutputConnector(): OutputConnector {
  const kind = (process.env.ANNOTATE_OUTPUT || "local").toLowerCase();
  if (kind === "local") {
    const dir = process.env.ANNOTATE_OUTPUT_DIR || "./annotations";
    console.log(`[annotate] output=local dir=${dir}`);
    return new LocalOutputConnector(dir);
  }
  if (kind === "gdrive") {
    const folderId = process.env.ANNOTATE_GDRIVE_FOLDER_ID;
    if (!folderId) throw new Error("ANNOTATE_GDRIVE_FOLDER_ID required for gdrive output");
    const authMode = process.env.ANNOTATE_GDRIVE_OAUTH_REFRESH_TOKEN ? "oauth" : "service-account";
    console.log(`[annotate] output=gdrive folder=${folderId} auth=${authMode}`);
    return new GDriveOutputConnector({ folderId });
  }
  throw new Error(`unknown ANNOTATE_OUTPUT: ${kind}`);
}

export type { InputConnector, OutputConnector } from "./types";
