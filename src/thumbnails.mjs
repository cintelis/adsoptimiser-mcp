// Thumbnails: small preview images attached to tool results so Claude can see
// what was generated (GET /api/v1/media/thumbnail). Behaviour and limits match
// the hosted connector (mcp.adsoptimiser.com.au): 384px previews, a per-image
// and a per-result byte budget, and failures that become notes in the text
// instead of tool errors. The structured content of a result is never changed.

import { ApiError } from "./api.mjs";

/** Bounding box (px) asked of the thumbnail endpoint. */
export const THUMBNAIL_SIZE = 384;
/** Most preview images a single result carries, per tool. */
export const THUMBNAIL_LIMITS = Object.freeze({
  get_job: 1,
  generate_image: 1,
  list_jobs: 6,
  get_character: 5,
  list_character_assets: 6,
});
/** Total base64 bytes of images in one result; beyond it images are dropped. */
export const THUMBNAIL_BUDGET_BYTES = 1_500_000;
/** Base64 bytes of one image; a larger one (an unscaled original) is dropped. */
export const THUMBNAIL_MAX_IMAGE_BYTES = 600_000;
const THUMBNAIL_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** The note used when the deployment has no thumbnail route for tokens. */
export const PREVIEWS_UNSUPPORTED = "this Ads Optimiser deployment doesn't serve previews yet";

/**
 * The storage key behind one of this deployment's public /media URLs, else
 * null. Only URLs on the API's own origin qualify, so nothing on another host
 * is ever asked for (and the token never leaves the API host).
 */
export function mediaKeyFromUrl(baseUrl, url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(baseUrl).origin) return null;
    const match = /^\/(?:api\/)?media\/(.+)$/.exec(parsed.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * True when the deployment predates the thumbnail route: tokens are refused
 * it (403 token_scope_denied), or the route does not exist (a 404 without the
 * route's own not_found code).
 */
function previewsUnsupported(err) {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 403 && err.code === "token_scope_denied") return true;
  return err.status === 404 && err.code !== "not_found";
}

function thumbnailFailure(err) {
  if (err instanceof ApiError) {
    const reason = typeof err.body?.reason === "string" ? err.body.reason : null;
    if (reason === "video_without_poster") return "video has no poster frame";
    if (err.code === "thumbnail_unavailable") return "preview unavailable right now";
    if (err.status === 404) return "not found";
    return err.code ?? `HTTP ${err.status}`;
  }
  return "preview failed";
}

/**
 * Fetch up to `max` previews and append them to the result as image blocks,
 * after a text line naming each one in order. Never fails the tool: anything
 * that cannot be previewed is named in the text instead.
 *
 * @param {import("./api.mjs").ApiClient} api
 * @param {{ content: Array<Record<string, unknown>> }} result
 * @param {Array<{ label: string, job_id?: string, key?: string }>} targets
 * @param {number} max
 * @param {string[]} [notes] reasons some items are not previewed, listed first
 */
export async function attachThumbnails(api, result, targets, max, notes = []) {
  const chosen = targets.slice(0, max);
  const skipped = [...notes];
  if (targets.length > chosen.length) {
    skipped.push(`${targets.length - chosen.length} more not previewed (at most ${max} per call)`);
  }

  const fetched = await Promise.all(
    chosen.map(async (target) => {
      const params = new URLSearchParams({ size: String(THUMBNAIL_SIZE) });
      if (target.job_id) params.set("job_id", target.job_id);
      else if (target.key) params.set("key", target.key);
      try {
        return { target, res: await api.requestBinary(`/api/v1/media/thumbnail?${params}`) };
      } catch (err) {
        return { target, error: thumbnailFailure(err), unsupported: previewsUnsupported(err) };
      }
    })
  );

  const images = [];
  const attached = [];
  let used = 0;
  let unsupported = 0;
  for (const item of fetched) {
    if (!item.res) {
      if (item.unsupported) unsupported += 1;
      else skipped.push(`${item.target.label}: ${item.error}`);
      continue;
    }
    const { bytes, contentType } = item.res;
    if (!THUMBNAIL_MIME_TYPES.has(contentType) || bytes.length === 0) {
      skipped.push(`${item.target.label}: not an image`);
      continue;
    }
    const data = bytes.toString("base64");
    if (data.length > THUMBNAIL_MAX_IMAGE_BYTES || used + data.length > THUMBNAIL_BUDGET_BYTES) {
      skipped.push(`${item.target.label}: left out to keep the result small`);
      continue;
    }
    used += data.length;
    images.push({ type: "image", data, mimeType: contentType });
    attached.push(item.target.label);
  }
  // An older deployment refuses every preview the same way: say so once.
  if (unsupported) skipped.push(PREVIEWS_UNSUPPORTED);

  if (!attached.length && !skipped.length) return result;
  const lines = [];
  if (attached.length) {
    const named = attached.map((label, i) => `${i + 1}) ${label}`).join("; ");
    lines.push(`Attached ${attached.length} preview image(s) (${THUMBNAIL_SIZE}px), in order: ${named}.`);
  } else {
    lines.push("No preview images attached.");
  }
  if (skipped.length) lines.push(`Not previewed: ${skipped.join("; ")}.`);
  return {
    ...result,
    content: [...result.content, { type: "text", text: lines.join("\n") }, ...images],
  };
}

/** Preview target for a job, or a note when it cannot have one. */
export function jobThumbnail(job) {
  if (job.status !== "ready" || !job.storage_uri) return {};
  if (job.asset_type === "video") {
    if (job.thumbnail_uri) {
      return { target: { label: `job ${job.job_id} (poster frame)`, job_id: job.job_id } };
    }
    return {
      note: `job ${job.job_id}: videos are not previewed unless a poster frame is stored; open its media URL to watch it`,
    };
  }
  return { target: { label: `job ${job.job_id}`, job_id: job.job_id } };
}

/** Preview targets for a character's reference images, and notes for the rest. */
export function characterThumbnails(baseUrl, images) {
  const targets = [];
  const notes = [];
  images.forEach((image, i) => {
    const label = `reference image ${i + 1}`;
    // Prefer the key: it is checked against the character itself, so it
    // still previews after the source job is gone.
    const key = mediaKeyFromUrl(baseUrl, image.url);
    if (key) targets.push({ label, key });
    else if (image.job_id) targets.push({ label, job_id: image.job_id });
    else notes.push(`${label}: external URL`);
  });
  return { targets, notes };
}

// ---------------------------------------------------------------------------
// View image: one larger image, optionally cropped, for detail checks
// ---------------------------------------------------------------------------

/** Sizes the thumbnail endpoint accepts, smallest first. */
export const THUMBNAIL_SIZES = Object.freeze([256, 384, 512, 768, 1024, 1536]);
/** Sizes adsoptimiser_view_image may ask for. */
export const VIEW_IMAGE_SIZES = Object.freeze([768, 1024, 1536]);
export const VIEW_IMAGE_DEFAULT_SIZE = 1024;
/** Base64 bytes of the one image view_image returns. */
export const VIEW_IMAGE_MAX_IMAGE_BYTES = 2_000_000;
/** Smallest crop width or height, as a fraction of the original. */
export const VIEW_IMAGE_MIN_CROP = 0.05;
export const VIEW_IMAGE_CROP_HINT =
  "Use crop to zoom into a region, e.g. { x: 0.3, y: 0.5, width: 0.4, height: 0.3 }";
/** The message used when the deployment predates view_image. */
export const VIEW_IMAGE_UNSUPPORTED =
  "this Ads Optimiser deployment doesn't support view_image yet; previews in other tools are 384px";

const CROP_EPSILON = 1e-9;

/**
 * Why a crop ({ x, y, width, height } fractions of the original) is invalid,
 * else null. The same rules as the API: every value in [0, 1], width and
 * height at least 0.05, and the region inside the image.
 */
export function cropError(crop) {
  if (!crop || typeof crop !== "object") return "crop must be an object { x, y, width, height }.";
  for (const name of ["x", "y", "width", "height"]) {
    const value = crop[name];
    if (typeof value !== "number" || !Number.isFinite(value)) return `crop.${name} must be a number.`;
    if (value < 0 || value > 1) return `crop.${name} must be between 0 and 1 (a fraction of the original image).`;
  }
  if (crop.width < VIEW_IMAGE_MIN_CROP - CROP_EPSILON || crop.height < VIEW_IMAGE_MIN_CROP - CROP_EPSILON) {
    return `crop.width and crop.height must each be at least ${VIEW_IMAGE_MIN_CROP}.`;
  }
  if (crop.x + crop.width > 1 + CROP_EPSILON) return "crop.x + crop.width must not exceed 1.";
  if (crop.y + crop.height > 1 + CROP_EPSILON) return "crop.y + crop.height must not exceed 1.";
  return null;
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** The API's crop parameter, "x,y,w,h", in plain decimals that stay inside the image. */
export function cropParam(crop) {
  const x = round6(crop.x);
  const y = round6(crop.y);
  const w = Math.min(round6(crop.width), round6(1 - x));
  const h = Math.min(round6(crop.height), round6(1 - y));
  return [x, y, w, h].map((n) => String(n)).join(",");
}

/** The next size down that the endpoint accepts, else null. */
export function nextSmallerSize(size) {
  const smaller = THUMBNAIL_SIZES.filter((s) => s < size);
  return smaller.length ? smaller[smaller.length - 1] : null;
}

/**
 * True when the deployment predates view_image: it refuses the larger sizes
 * (400 invalid_size; only valid sizes are ever sent), refuses the route to
 * tokens (403 token_scope_denied), or has no such route (a 404 without the
 * route's own not_found code).
 */
export function viewImageUnsupported(err) {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 400 && err.code === "invalid_size") return true;
  return previewsUnsupported(err);
}

/**
 * What to ask the endpoint for to show a character's reference image
 * `index` (1-based), resolved as get_character's previews are: this
 * deployment's /media key, else the source job. An image on another host
 * gives `{ external }` and is never fetched.
 */
export function characterImageTarget(baseUrl, images, index) {
  const image = images[index - 1];
  if (!image) return { missing: true };
  const key = mediaKeyFromUrl(baseUrl, image.url);
  if (key) return { key };
  if (image.job_id) return { job_id: image.job_id };
  return { external: typeof image.url === "string" ? image.url : "" };
}

/** A positive whole number from a response header, else null. */
export function headerInt(headers, name) {
  const value = Number.parseInt(headers?.get?.(name) ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const VIEW_IMAGE_MIME_TYPES = THUMBNAIL_MIME_TYPES;
