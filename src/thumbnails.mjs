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
