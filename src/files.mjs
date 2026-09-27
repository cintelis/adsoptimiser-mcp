// Local file handling: what may be uploaded, where downloads may be written,
// and how they are named. Everything here runs before (or after) a network
// call, so a bad path fails fast without using any allowance.

import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LocalFileError } from "./api.mjs";

/** Mirrors POST /api/v1/jobs/source-media: images max 10 MB, videos max 120 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
export const MAX_PROMPTS_FILE_BYTES = 256 * 1024;
export const DEFAULT_OUTPUT_FOLDER = "adsoptimiser-output";

export const IMAGE_EXTENSIONS = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
export const VIDEO_EXTENSIONS = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};
const CONVERT_FIRST = new Set([".heic", ".heif", ".tif", ".tiff", ".avif", ".bmp"]);

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `~/x` and `~\x` expand to the home directory; relative paths resolve against `base`. */
export function expandPath(raw, base) {
  const value = String(raw ?? "").trim();
  if (!value) throw new LocalFileError("A file path is required.");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

/** The real image type from the first bytes, or null when it is not an image we accept. */
export function sniffImageType(head) {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 4 && head.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function readHead(path, length = 16) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Validate a local file for upload. `expected` narrows the kind.
 * @returns {Promise<{ path: string, name: string, kind: "image"|"video", mime: string, size: number }>}
 */
export async function inspectLocalMedia(rawPath, { base, expected = "any" }) {
  const path = expandPath(rawPath, base);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new LocalFileError(`File not found: ${path}`);
  }
  if (info.isDirectory()) throw new LocalFileError(`${path} is a folder, not a file.`);
  if (!info.isFile()) throw new LocalFileError(`${path} is not a regular file.`);

  const name = basename(path);
  const ext = extname(name).toLowerCase();
  let kind = null;
  if (IMAGE_EXTENSIONS[ext]) kind = "image";
  else if (VIDEO_EXTENSIONS[ext]) kind = "video";

  if (!kind) {
    if (CONVERT_FIRST.has(ext)) {
      throw new LocalFileError(
        `${name}: ${ext} images are not supported. Convert it to JPEG or PNG first.`
      );
    }
    throw new LocalFileError(
      `${name}: unsupported file type. Images: ${Object.keys(IMAGE_EXTENSIONS).join(", ")}. Videos: ${Object.keys(VIDEO_EXTENSIONS).join(", ")}.`
    );
  }
  if (expected !== "any" && kind !== expected) {
    throw new LocalFileError(`${name} is a ${kind}, but an ${expected} is needed here.`);
  }
  if (info.size === 0) throw new LocalFileError(`${name} is empty.`);
  const max = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (info.size > max) {
    throw new LocalFileError(
      `${name} is ${formatMb(info.size)}; the limit for ${kind}s is ${formatMb(max)}.`
    );
  }

  let mime = kind === "image" ? IMAGE_EXTENSIONS[ext] : VIDEO_EXTENSIONS[ext];
  if (kind === "image") {
    // Trust the bytes over the name: a renamed JPEG still uploads correctly,
    // and a text file called photo.png is refused here, not by the server.
    const sniffed = sniffImageType(await readHead(path));
    if (!sniffed) {
      throw new LocalFileError(`${name} does not look like a PNG, JPEG, WebP or GIF image.`);
    }
    mime = sniffed;
  }
  return { path, name, kind, mime, size: info.size };
}

/** Images in a folder (not recursive), sorted by name, hidden files skipped. */
export async function listImagesInFolder(rawFolder, base) {
  const folder = expandPath(rawFolder, base);
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    throw new LocalFileError(`Folder not found: ${folder}`);
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith(".") && IMAGE_EXTENSIONS[extname(e.name).toLowerCase()])
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { folder, files: files.map((name) => join(folder, name)) };
}

/** One prompt per line; blank lines and lines starting with # are skipped. */
export async function readPromptsFile(rawPath, base) {
  const path = expandPath(rawPath, base);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new LocalFileError(`Prompts file not found: ${path}`);
  }
  if (!info.isFile()) throw new LocalFileError(`${path} is not a file.`);
  if (info.size > MAX_PROMPTS_FILE_BYTES) {
    throw new LocalFileError(
      `${basename(path)} is ${formatMb(info.size)}; prompts files are limited to ${MAX_PROMPTS_FILE_BYTES / 1024} kB.`
    );
  }
  const prompts = (await readFile(path, "utf8"))
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return { path, prompts };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/**
 * Where relative output folders resolve. Claude Desktop starts MCP servers in
 * the filesystem root (macOS) or its own install folder; a root or Windows
 * system folder falls back to the home directory rather than writing there.
 */
export function defaultOutputBase(cwd = process.cwd(), env = process.env) {
  const configured = env.ADSOPTIMISER_OUTPUT_DIR?.trim();
  if (configured) {
    const folder = expandPath(configured, cwd);
    return { base: folder, folder };
  }
  const here = resolve(cwd);
  const systemRoot = env.SystemRoot ? resolve(env.SystemRoot).toLowerCase() : null;
  const unsuitable =
    here === parse(here).root || (systemRoot && here.toLowerCase().startsWith(systemRoot));
  const base = unsuitable ? homedir() : here;
  return { base, folder: join(base, DEFAULT_OUTPUT_FOLDER) };
}

/** Resolve the download folder, refusing any `..` segment in what was asked for. */
export function resolveOutputFolder(raw, defaults) {
  const value = String(raw ?? "").trim();
  if (!value) return defaults.folder;
  if (value.split(/[\\/]+/).includes("..")) {
    throw new LocalFileError(
      `Refusing the folder "${value}": it contains "..". Give a folder path without parent-directory steps.`
    );
  }
  return expandPath(value, defaults.base);
}

/** Lower-case ASCII words joined by hyphens, at most `max` characters. */
export function slugify(textValue, max = 40) {
  const slug = String(textValue ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

const EXTENSION_BY_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};
const SAFE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov"]);

export function extensionFor({ storageUri, contentType, assetType }) {
  const fromKey = extname(String(storageUri ?? "")).toLowerCase();
  if (SAFE_EXTENSIONS.has(fromKey)) return fromKey;
  const fromType = EXTENSION_BY_TYPE[String(contentType ?? "").split(";")[0].trim().toLowerCase()];
  if (fromType) return fromType;
  return assetType === "video" ? ".mp4" : ".png";
}

/** `<job id>-<prompt slug><ext>`; the job id is already restricted to [A-Za-z0-9_-]. */
export function downloadFileName(jobId, prompt, ext) {
  const safeId = String(jobId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  const slug = slugify(prompt);
  return `${safeId}${slug ? `-${slug}` : ""}${ext}`;
}

/**
 * Stream a web ReadableStream into `folder/fileName`. Never overwrites unless
 * `overwrite` is set: an existing name gets a -2, -3 ... suffix instead, and
 * the result says which name was used.
 */
export async function saveStream(body, folder, fileName, { overwrite = false } = {}) {
  await mkdir(folder, { recursive: true });
  const folderInfo = await stat(folder);
  if (!folderInfo.isDirectory()) throw new LocalFileError(`${folder} exists and is not a folder.`);

  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let attempt = 1; attempt <= 100; attempt++) {
    const candidate = attempt === 1 ? fileName : `${stem}-${attempt}${ext}`;
    const target = resolve(folder, candidate);
    // Defence in depth: the name is generated, but the target must still sit
    // directly inside the chosen folder.
    if (dirname(target) !== resolve(folder) || candidate.includes(sep)) {
      throw new LocalFileError(`Refusing to write outside ${folder}.`);
    }
    let handle;
    try {
      handle = await open(target, overwrite ? "w" : "wx");
    } catch (err) {
      if (err?.code === "EEXIST") continue;
      throw new LocalFileError(`Could not create ${target}: ${err?.message ?? err}`);
    }
    try {
      // The stream owns the handle from here and closes it on finish or error.
      await pipeline(Readable.fromWeb(body), handle.createWriteStream());
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(target).catch(() => {});
      throw new LocalFileError(`Download interrupted; nothing was kept: ${err?.message ?? err}`);
    }
    const { size } = await stat(target);
    return { path: target, fileName: candidate, bytes: size, renamed: candidate !== fileName };
  }
  throw new LocalFileError(`Too many files named like ${fileName} in ${folder}.`);
}
