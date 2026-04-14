import type { IncomingMessage, ServerResponse } from "node:http";
import { errorBody, toHttpError } from "./http-errors.js";
import { RequestValidationError } from "./request-parsing.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new RequestValidationError(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequestValidationError("request body must be valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    return;
  }
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", body.byteLength);
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  const httpError = toHttpError(err);
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  sendJson(res, httpError.status, errorBody(httpError));
}
