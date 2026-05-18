import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT_PATH = fileURLToPath(new URL("../web/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface FrontendFsApi {
  readFileSync: typeof readFileSync;
  statSync: typeof statSync;
}

type FrontendReadResult =
  | {
      kind: "asset";
      body: Buffer;
      contentType: string;
    }
  | {
      kind: "missing";
    }
  | {
      kind: "error";
      error: unknown;
    };

function webRootPath(): string {
  return WEB_ROOT_PATH;
}

export function resolveFrontendPath(
  rootPath: string,
  pathname: string,
  pathApi: Pick<typeof path, "isAbsolute" | "normalize" | "relative" | "resolve" | "sep"> = path,
): string | null {
  const strippedPath = pathname.replace(/^[/\\]+/, "");
  const relativePath = pathname === "/" ? "index.html" : pathApi.normalize(strippedPath);
  const resolvedPath = pathApi.resolve(rootPath, relativePath);
  const relativeToRoot = pathApi.relative(rootPath, resolvedPath);
  if (
    relativeToRoot === "" ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativeToRoot)
  ) {
    return null;
  }
  return resolvedPath;
}

function readFrontendFile(
  pathname: string,
  rootPath: string,
  fsApi: FrontendFsApi,
): FrontendReadResult {
  const resolvedPath = resolveFrontendPath(rootPath, pathname);
  if (!resolvedPath) {
    return { kind: "missing" };
  }
  try {
    const stats = fsApi.statSync(resolvedPath, { throwIfNoEntry: false });
    if (!stats?.isFile()) {
      return { kind: "missing" };
    }
    return {
      kind: "asset",
      body: fsApi.readFileSync(resolvedPath),
      contentType: CONTENT_TYPES[path.extname(resolvedPath)] ?? "application/octet-stream",
    };
  } catch (error) {
    return { kind: "error", error };
  }
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
  const cacheControl =
    status >= 400
      ? "no-store"
      : contentType.startsWith("text/html")
        ? "no-cache"
        : "public, max-age=31536000, immutable";
  res.setHeader("cache-control", cacheControl);
  res.setHeader("content-length", String(body.length));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function htmlWithWebBasePath(body: Buffer, webBasePath: string): Buffer {
  const prefix = webBasePath === "/" ? "" : webBasePath;
  if (!prefix) {
    return body;
  }
  const html = body.toString("utf8");
  const injected = `<script>window.__AGENT_RUNNER_WEB_BASE_PATH__=${JSON.stringify(webBasePath)};</script>`;
  const withInjectedBasePath = html.includes("</head>")
    ? html.replace("</head>", `${injected}</head>`)
    : `${injected}${html}`;
  return Buffer.from(
    withInjectedBasePath
      .replaceAll('src="/assets/', `src="${prefix}/assets/`)
      .replaceAll("src='/assets/", `src='${prefix}/assets/`)
      .replaceAll('href="/assets/', `href="${prefix}/assets/`)
      .replaceAll("href='/assets/", `href='${prefix}/assets/`),
    "utf8",
  );
}

function sendFrontendAsset(
  req: IncomingMessage,
  res: ServerResponse,
  asset: Extract<FrontendReadResult, { kind: "asset" }>,
  webBasePath: string,
): void {
  const body = asset.contentType.startsWith("text/html")
    ? htmlWithWebBasePath(asset.body, webBasePath)
    : asset.body;
  sendBuffer(req, res, 200, body, asset.contentType);
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  sendBuffer(req, res, status, Buffer.from(body, "utf8"), contentType);
}

export function serveFrontendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: {
    rootPath?: string;
    fsApi?: FrontendFsApi;
    logError?: (error: unknown) => void;
    webBasePath?: string;
  } = {},
): void {
  const rootPath = options.rootPath ?? webRootPath();
  const fsApi = options.fsApi ?? { statSync, readFileSync };
  const logError = options.logError ?? ((error: unknown) => console.error(error));
  const webBasePath = options.webBasePath ?? "/";

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return;
  }

  const asset = readFrontendFile(pathname, rootPath, fsApi);
  if (asset.kind === "asset") {
    sendFrontendAsset(req, res, asset, webBasePath);
    return;
  }
  if (asset.kind === "error") {
    logError(asset.error);
    sendText(req, res, 500, "Failed to read agent-runner web assets.");
    return;
  }

  if (path.extname(pathname)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  const indexFile = readFrontendFile("/", rootPath, fsApi);
  if (indexFile.kind === "error") {
    logError(indexFile.error);
    sendText(req, res, 500, "Failed to read agent-runner web assets.");
    return;
  }
  if (indexFile.kind === "missing") {
    sendText(req, res, 503, "agent-runner web assets are not available; run npm run build");
    return;
  }

  sendFrontendAsset(req, res, indexFile, webBasePath);
}
