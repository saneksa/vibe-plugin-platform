/**
 * HTTP API for the demo backend. The registry is the single source of truth for
 * active versions; every successful activation is persisted explicitly.
 */
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getMeta, getPolicy } from "@vibe/plugin-contracts/protocol";
import type { Registry } from "./registry.js";
import { handleUpload, MAX_ARCHIVE_BYTES } from "./upload.js";

/** Concrete demo host version; `getMeta()` deliberately leaves it optional. */
const HOST_VERSION = "2.4.0";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Express 4 does not forward rejected async handlers to error middleware. */
const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

/** Pull the first file part out of a multipart body produced by `FormData`. */
function archiveFromMultipart(req: Request): Uint8Array {
  const contentType = req.headers["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) {
    throw new HttpError(400, "INVALID_UPLOAD", "expected multipart/form-data with a boundary");
  }
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]!.trim()}`);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") break; // closing delimiter
    if (body.subarray(start, start + 2).toString() === "\r\n") start += 2;
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const headers = body.subarray(start, headerEnd).toString("latin1");
    const contentStart = headerEnd + 4;
    const next = body.indexOf(delimiter, contentStart);
    if (next === -1) break;
    const contentEnd =
      body[next - 2] === 13 && body[next - 1] === 10 ? next - 2 : next; // strip the part's CRLF
    if (/filename=/i.test(headers)) {
      return new Uint8Array(body.subarray(contentStart, contentEnd));
    }
    cursor = next;
  }
  throw new HttpError(400, "INVALID_UPLOAD", "multipart body contains no archive file");
}

export function createApiRouter(opts: { registry: Registry; storageDir: string }): Router {
  const { registry, storageDir } = opts;
  const router = express.Router();

  router.post(
    "/api/plugins",
    express.raw({ type: "multipart/form-data", limit: MAX_ARCHIVE_BYTES }),
    asyncRoute(async (req, res) => {
      const zip = archiveFromMultipart(req);
      // handleUpload validates, extracts and calls registry.save() on success.
      const result = await handleUpload(zip, registry, join(storageDir, "plugins"));
      res.status(result.status).json(result.body);
    }),
  );

  router.get("/api/plugins", (_req, res) => {
    const versions = registry.list();
    const activeVersion: Record<string, string> = {};
    for (const id of new Set(versions.map((dto) => dto.id))) {
      try {
        activeVersion[id] = registry.activeVersion(id);
      } catch {
        // A descriptor without an active version is still reported.
      }
    }
    res.json({ versions, activeVersion });
  });

  router.put(
    "/api/plugins/:id/active",
    express.json({ limit: MAX_ARCHIVE_BYTES }),
    asyncRoute((req, res) => {
      const version = (req.body as { version?: unknown } | undefined)?.version;
      if (typeof version !== "string" || version.length === 0) {
        throw new HttpError(400, "INVALID_VERSION", "body must contain a version string");
      }
      const id = req.params.id!;
      const installed = registry.list().some((dto) => dto.id === id && dto.version === version);
      if (!installed) {
        throw new HttpError(404, "VERSION_NOT_INSTALLED", `plugin "${id}@${version}" is not installed`);
      }
      try {
        // setActive applies the shared hostAPI gate; save persists backend state.
        registry.setActive(id, version);
        registry.save();
      } catch (error) {
        throw new HttpError(409, "HOST_API_UNSUPPORTED", messageOf(error));
      }
      const descriptor = registry.list().find((dto) => dto.id === id && dto.version === version);
      res.json(descriptor);
    }),
  );

  router.delete("/api/plugins/:id", (req, res) => {
    const id = req.params.id!;
    // Uninstall every version: registry first (unknown id → 404 before any
    // filesystem change), then the unpacked directory.
    let removed: ReturnType<Registry["delete"]>;
    try {
      removed = registry.delete(id);
    } catch {
      throw new HttpError(404, "PLUGIN_NOT_FOUND", `plugin "${id}" is not installed`);
    }
    rmSync(join(storageDir, "plugins", id), { recursive: true, force: true });
    res.json({ ok: true, removed });
  });

  router.get("/api/meta", (_req, res) => {
    // getMeta() derives `sunset` from the FIRST deprecated entry only — the
    // exported policy currently has a single deprecation (major 1).
    const meta = getMeta(getPolicy());
    res.json({ hostVersion: HOST_VERSION, ...meta });
  });

  return router;
}

export const apiErrorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = err.status;
    if (status === 413) {
      res
        .status(413)
        .json({ code: "ARCHIVE_TOO_LARGE", message: `archive exceeds ${MAX_ARCHIVE_BYTES} bytes` });
      return;
    }
    // Malformed JSON / unsupported media types from body-parser are client errors.
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ code: "BAD_REQUEST", message: messageOf(err) });
      return;
    }
  }
  res.status(500).json({ code: "INTERNAL_ERROR", message: messageOf(err) });
};
