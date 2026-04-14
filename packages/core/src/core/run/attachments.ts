import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RunAttachment } from "../../contracts/attachments.js";
import type { RunManifest } from "./manifest.js";

export const MAX_ATTACHMENTS_PER_RUN = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const ATTACHMENTS_DIR = "attachments";

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0);
  return code !== undefined && (code <= 0x1f || code === 0x7f);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".txt": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".zip": "application/zip",
};

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export class AttachmentNotFoundError extends AttachmentError {
  constructor(runId: string, attachmentId: string) {
    super(`attachment "${attachmentId}" not found in run ${runId}`);
    this.name = "AttachmentNotFoundError";
  }
}

export class AttachmentPolicyError extends AttachmentError {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentPolicyError";
  }
}

export class AttachmentIntegrityError extends AttachmentError {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentIntegrityError";
  }
}

export function cloneAttachment(attachment: RunAttachment): RunAttachment {
  return { ...attachment };
}

export function cloneAttachments(attachments: RunAttachment[]): RunAttachment[] {
  return attachments.map(cloneAttachment);
}

export function attachmentCount(manifest: Pick<RunManifest, "attachments">): number {
  return manifest.attachments.length;
}

export function attachmentTotalBytes(
  manifest: Pick<RunManifest, "attachments"> | Pick<RunManifest, "attachments">["attachments"],
): number {
  const attachments = Array.isArray(manifest) ? manifest : manifest.attachments;
  return attachments.reduce((total, attachment) => total + attachment.size, 0);
}

export function validateAttachmentName(name: string, label = "attachment name"): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new AttachmentError(`${label} cannot be empty`);
  }
  if (Array.from(trimmed).some(isControlCharacter)) {
    throw new AttachmentError(`${label} cannot contain control characters`);
  }
  if (trimmed === "." || trimmed === "..") {
    throw new AttachmentError(`${label} cannot be "." or ".."`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new AttachmentError(`${label} must be a single path segment`);
  }
  return trimmed;
}

export function sanitizeAttachmentFilename(name: string): string {
  const trimmed = basename(name.trim());
  const sanitized = trimmed
    .split("")
    .filter((char) => !isControlCharacter(char))
    .join("")
    .replace(/[\\/]+/g, "-")
    .replace(/^\.+$/, "")
    .trim();
  return sanitized.length > 0 ? sanitized : "attachment";
}

export function resolveAttachmentMimeType(name: string, override?: string): string {
  const normalizedOverride = override?.trim();
  if (normalizedOverride) {
    return normalizedOverride;
  }
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function createAttachmentRelativePath(id: string, name: string): string {
  return `${ATTACHMENTS_DIR}/${id}/${sanitizeAttachmentFilename(name)}`;
}

export function resolveAttachmentAbsolutePath(workspaceDir: string, relativePath: string): string {
  const absolutePath = resolve(workspaceDir, relativePath);
  const rel = relative(workspaceDir, absolutePath);
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    relativePath.length === 0 ||
    absolutePath === workspaceDir
  ) {
    throw new AttachmentIntegrityError(
      `attachment path "${relativePath}" escapes the run workspace`,
    );
  }
  return absolutePath;
}

export function getAttachment(
  manifest: Pick<RunManifest, "attachments" | "runId">,
  attachmentId: string,
): RunAttachment {
  const attachment = manifest.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) {
    throw new AttachmentNotFoundError(manifest.runId, attachmentId);
  }
  return cloneAttachment(attachment);
}

export function attachmentStoragePath(
  manifest: Pick<RunManifest, "attachments" | "runId" | "workspaceDir">,
  attachmentId: string,
): { attachment: RunAttachment; absolutePath: string } {
  const attachment = getAttachment(manifest, attachmentId);
  return {
    attachment,
    absolutePath: resolveAttachmentAbsolutePath(manifest.workspaceDir, attachment.relativePath),
  };
}

function ensureAttachmentLimits(
  manifest: Pick<RunManifest, "attachments" | "runId">,
  incomingBytes: number,
): void {
  if (manifest.attachments.length >= MAX_ATTACHMENTS_PER_RUN) {
    throw new AttachmentPolicyError(
      `attachment add: run ${manifest.runId} already has ${manifest.attachments.length} attachments (max ${MAX_ATTACHMENTS_PER_RUN})`,
    );
  }
  if (incomingBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentPolicyError(
      `attachment add: file exceeds ${MAX_ATTACHMENT_BYTES} bytes (25 MiB max)`,
    );
  }
  const totalBytes = attachmentTotalBytes(manifest);
  if (totalBytes + incomingBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AttachmentPolicyError(
      `attachment add: total attachment bytes would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes (100 MiB max)`,
    );
  }
}

async function sha256ForPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function stageAttachmentFromFile(
  manifest: Pick<RunManifest, "attachments" | "runId" | "workspaceDir">,
  input: {
    id: string;
    name: string;
    sourcePath: string;
    mimeType?: string;
    addedAt?: string;
  },
): Promise<RunAttachment> {
  const displayName = validateAttachmentName(input.name);
  const sourceStat = statSync(input.sourcePath);
  if (!sourceStat.isFile()) {
    throw new AttachmentError(`attachment add: ${input.sourcePath} is not a file`);
  }
  ensureAttachmentLimits(manifest, sourceStat.size);

  const relativePath = createAttachmentRelativePath(input.id, displayName);
  const absolutePath = resolveAttachmentAbsolutePath(manifest.workspaceDir, relativePath);
  const parentDir = dirname(absolutePath);
  mkdirSync(parentDir, { recursive: true });
  const tempDir = mkdtempSync(join(parentDir, ".tmp-"));
  const tempPath = join(tempDir, "attachment.bin");
  const writeHash = createHash("sha256");
  let totalBytes = 0;

  try {
    await pipeline(
      createReadStream(input.sourcePath),
      async function* (source) {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > MAX_ATTACHMENT_BYTES) {
            throw new AttachmentPolicyError(
              `attachment add: file exceeds ${MAX_ATTACHMENT_BYTES} bytes (25 MiB max)`,
            );
          }
          writeHash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(tempPath, { flags: "wx" }),
    );

    const committedSize = statSync(tempPath).size;
    const committedHash = await sha256ForPath(tempPath);
    const expectedHash = writeHash.digest("hex");
    if (committedSize !== totalBytes) {
      throw new AttachmentIntegrityError(
        `attachment add: size verification failed for ${displayName}`,
      );
    }
    if (committedHash !== expectedHash) {
      throw new AttachmentIntegrityError(
        `attachment add: hash verification failed for ${displayName}`,
      );
    }
    rmSync(absolutePath, { force: true });
    mkdirSync(dirname(absolutePath), { recursive: true });
    copyFileSync(tempPath, absolutePath);

    return {
      id: input.id,
      name: displayName,
      mimeType: resolveAttachmentMimeType(displayName, input.mimeType),
      size: committedSize,
      sha256: committedHash,
      addedAt: input.addedAt ?? new Date().toISOString(),
      relativePath,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function stageAttachmentFromStream(
  manifest: Pick<RunManifest, "attachments" | "runId" | "workspaceDir">,
  input: {
    id: string;
    name: string;
    source: AsyncIterable<Uint8Array>;
    mimeType?: string;
    addedAt?: string;
  },
): Promise<RunAttachment> {
  const displayName = validateAttachmentName(input.name);
  if (manifest.attachments.length >= MAX_ATTACHMENTS_PER_RUN) {
    throw new AttachmentPolicyError(
      `attachment add: run ${manifest.runId} already has ${manifest.attachments.length} attachments (max ${MAX_ATTACHMENTS_PER_RUN})`,
    );
  }

  const relativePath = createAttachmentRelativePath(input.id, displayName);
  const absolutePath = resolveAttachmentAbsolutePath(manifest.workspaceDir, relativePath);
  const parentDir = dirname(absolutePath);
  mkdirSync(parentDir, { recursive: true });
  const tempDir = mkdtempSync(join(parentDir, ".tmp-"));
  const tempPath = join(tempDir, "attachment.bin");
  const writeHash = createHash("sha256");
  let totalBytes = 0;

  try {
    await pipeline(
      input.source,
      async function* (source) {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > MAX_ATTACHMENT_BYTES) {
            throw new AttachmentPolicyError(
              `attachment add: file exceeds ${MAX_ATTACHMENT_BYTES} bytes (25 MiB max)`,
            );
          }
          if (attachmentTotalBytes(manifest) + totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
            throw new AttachmentPolicyError(
              `attachment add: total attachment bytes would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes (100 MiB max)`,
            );
          }
          writeHash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(tempPath, { flags: "wx" }),
    );

    const committedSize = statSync(tempPath).size;
    if (attachmentTotalBytes(manifest) + committedSize > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentPolicyError(
        `attachment add: total attachment bytes would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes (100 MiB max)`,
      );
    }
    const committedHash = await sha256ForPath(tempPath);
    const expectedHash = writeHash.digest("hex");
    if (committedSize !== totalBytes) {
      throw new AttachmentIntegrityError(
        `attachment add: size verification failed for ${displayName}`,
      );
    }
    if (committedHash !== expectedHash) {
      throw new AttachmentIntegrityError(
        `attachment add: hash verification failed for ${displayName}`,
      );
    }
    rmSync(absolutePath, { force: true });
    mkdirSync(dirname(absolutePath), { recursive: true });
    copyFileSync(tempPath, absolutePath);

    return {
      id: input.id,
      name: displayName,
      mimeType: resolveAttachmentMimeType(displayName, input.mimeType),
      size: committedSize,
      sha256: committedHash,
      addedAt: input.addedAt ?? new Date().toISOString(),
      relativePath,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function removeAttachmentFiles(
  manifest: Pick<RunManifest, "attachments" | "runId" | "workspaceDir">,
  attachmentId: string,
): RunAttachment {
  const { attachment, absolutePath } = attachmentStoragePath(manifest, attachmentId);
  rmSync(dirname(absolutePath), { recursive: true, force: true });
  const attachmentsRoot = join(manifest.workspaceDir, ATTACHMENTS_DIR);
  if (existsSync(attachmentsRoot) && readdirSync(attachmentsRoot).length === 0) {
    rmSync(attachmentsRoot, { recursive: true, force: true });
  }
  return attachment;
}

export function resolveAttachmentOutputPath(outputPath: string, attachmentName: string): string {
  const hasTrailingSlash = outputPath.endsWith("/") || outputPath.endsWith("\\");
  if (hasTrailingSlash) {
    const directoryPath = resolve(outputPath);
    if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
      throw new AttachmentError(
        `attachment download: destination directory ${directoryPath} was not found`,
      );
    }
    const resolvedPath = join(directoryPath, attachmentName);
    if (existsSync(resolvedPath)) {
      throw new AttachmentError(
        `attachment download: destination file ${resolvedPath} already exists`,
      );
    }
    return resolvedPath;
  }

  const resolvedPath = resolve(outputPath);
  if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
    const candidate = join(resolvedPath, attachmentName);
    if (existsSync(candidate)) {
      throw new AttachmentError(
        `attachment download: destination file ${candidate} already exists`,
      );
    }
    return candidate;
  }
  if (existsSync(resolvedPath)) {
    throw new AttachmentError(
      `attachment download: destination file ${resolvedPath} already exists`,
    );
  }
  const parentDir = resolve(dirname(resolvedPath));
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    throw new AttachmentError(
      `attachment download: destination directory ${parentDir} was not found`,
    );
  }
  return resolvedPath;
}
