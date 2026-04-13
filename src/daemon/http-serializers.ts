import type { IncomingMessage, ServerResponse } from "node:http";
import { errorBody, toHttpError } from "./http-errors.js";
import { RequestValidationError } from "./request-parsing.js";

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

export function sendError(res: ServerResponse, err: unknown): void {
  const httpError = toHttpError(err);
  sendJson(res, httpError.status, errorBody(httpError));
}
