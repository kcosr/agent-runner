import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

const WEB_ROOT_URL = new URL("../web/", import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function webRootPath(): string {
  return WEB_ROOT_URL.pathname;
}

function readFrontendFile(pathname: string): { body: Buffer; contentType: string } | null {
  const relativePath = pathname === "/" ? "index.html" : normalize(pathname).replace(/^\/+/, "");
  const resolvedPath = join(webRootPath(), relativePath);
  if (!resolvedPath.startsWith(webRootPath()) || !existsSync(resolvedPath)) {
    return null;
  }

  return {
    body: readFileSync(resolvedPath),
    contentType: CONTENT_TYPES[extname(resolvedPath)] ?? "application/octet-stream",
  };
}

function sendBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader(
    "cache-control",
    contentType.startsWith("text/html") ? "no-cache" : "public, max-age=31536000, immutable",
  );
  res.setHeader("content-length", String(body.length));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

export function serveFrontendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  const asset = readFrontendFile(pathname);
  if (asset) {
    sendBuffer(req, res, 200, asset.body, asset.contentType);
    return;
  }

  if (extname(pathname)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  const indexFile = readFrontendFile("/");
  if (!indexFile) {
    res.statusCode = 503;
    res.end("task-runner web assets are not available; run npm run build");
    return;
  }

  sendBuffer(req, res, 200, indexFile.body, indexFile.contentType);
}
