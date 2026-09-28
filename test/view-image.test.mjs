// adsoptimiser_view_image: one larger image (768, 1024 or 1536 px), optionally
// cropped, from GET /api/v1/media/thumbnail, with the shared contract's
// validation, character resolution, byte budget, errors and the fallback for
// deployments that predate it.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROUTES } from "../src/server.mjs";
import {
  VIEW_IMAGE_MAX_IMAGE_BYTES,
  VIEW_IMAGE_UNSUPPORTED,
  cropError,
  cropParam,
  nextSmallerSize,
} from "../src/thumbnails.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const TOOL = "adsoptimiser_view_image";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const THUMB_SIZES = [256, 384, 512, 768, 1024, 1536];

/**
 * A stub of the thumbnail endpoint as the contract describes it: sizes,
 * crop (fractions of the original, applied before scaling, never
 * upscaling), the size headers and the error codes.
 *
 * state.originals: id or key -> { width, height }
 * state.bytesAt(size): body length to send (default: small)
 * state.error(q): an error reply for this request, if any
 * state.legacy: behave like a 0.6-era server (sizes up to 512, no crop)
 */
function makeApi(state, origin) {
  return (r) => {
    const route = `${r.method} ${r.path}`;
    if (route === "GET /api/v1/media/thumbnail") {
      const q = Object.fromEntries(r.url.searchParams);
      const size = Number(q.size);
      if (state.legacy) {
        if (![256, 384, 512].includes(size)) {
          return { status: 400, json: { code: "invalid_size", error: "size must be 256, 384 or 512" } };
        }
      }
      const custom = state.error?.(q);
      if (custom) return custom;
      if (!THUMB_SIZES.includes(size)) return { status: 400, json: { code: "invalid_size", error: "bad size" } };
      const id = q.job_id ?? q.key;
      const original = state.originals?.[id];
      if (!original) return { status: 404, json: { code: "not_found", error: "No such image" } };
      let w = original.width;
      let h = original.height;
      if (q.crop) {
        const [cx, cy, cw, ch] = q.crop.split(",").map(Number);
        if ([cx, cy, cw, ch].some((n) => !Number.isFinite(n)) || cw < 0.05 || ch < 0.05 || cx + cw > 1 || cy + ch > 1) {
          return { status: 400, json: { code: "invalid_crop", error: "crop out of range" } };
        }
        w = Math.round(w * cw);
        h = Math.round(h * ch);
      }
      const scale = Math.min(1, size / Math.max(w, h));
      const length = state.bytesAt?.(size) ?? 16;
      const body = Buffer.alloc(length, 7);
      JPEG.copy(body, 0, 0, Math.min(JPEG.length, length));
      return {
        headers: {
          "content-type": state.contentType ?? "image/jpeg",
          "x-image-width": String(Math.round(w * scale)),
          "x-image-height": String(Math.round(h * scale)),
          ...(state.hideOriginal
            ? {}
            : { "x-original-width": String(original.width), "x-original-height": String(original.height) }),
          "x-thumbnail-source": "transformed",
          "x-thumbnail-key": id,
          "x-thumbnail-size": String(size),
        },
        body,
      };
    }
    if (route === "GET /api/v1/characters/chr_amos") {
      return {
        json: {
          character_id: "chr_amos",
          name: "Amos",
          images: [
            { url: `${origin}/media/${encodeURIComponent("characters/amos-1.png")}`, job_id: "job_a1" },
            { url: "https://cdn.example.com/amos-2.png", job_id: "job_a2" },
            { url: "https://cdn.example.com/amos-3.png", job_id: null },
          ],
        },
      };
    }
    if (route === "GET /api/v1/characters/chr_ghost") return { status: 404, json: { code: "not_found", error: "No such character" } };
    return undefined;
  };
}

async function callRaw(ctx, args) {
  const result = await ctx.client.callTool({ name: TOOL, arguments: args });
  const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
  return {
    result,
    content: result.content,
    text: texts.join("\n"),
    images: result.content.filter((c) => c.type === "image"),
    structured: result.structuredContent,
    isError: result.isError === true,
  };
}

describe("crop helpers", () => {
  it("accepts regions inside the image and refuses the rest", () => {
    assert.equal(cropError({ x: 0, y: 0, width: 1, height: 1 }), null);
    assert.equal(cropError({ x: 0.3, y: 0.5, width: 0.4, height: 0.3 }), null);
    assert.equal(cropError({ x: 0.95, y: 0.95, width: 0.05, height: 0.05 }), null);
    assert.match(cropError({ x: 0.7, y: 0, width: 0.4, height: 0.5 }), /x \+ crop\.width/);
    assert.match(cropError({ x: 0, y: 0.6, width: 0.4, height: 0.5 }), /y \+ crop\.height/);
    assert.match(cropError({ x: 0, y: 0, width: 0.04, height: 0.5 }), /at least 0\.05/);
    assert.match(cropError({ x: -0.1, y: 0, width: 0.5, height: 0.5 }), /between 0 and 1/);
    assert.match(cropError({ x: 0, y: 0, width: 0.5 }), /crop\.height must be a number/);
  });

  it("maps to x,y,w,h in plain decimals that stay inside the image", () => {
    assert.equal(cropParam({ x: 0.3, y: 0.5, width: 0.4, height: 0.3 }), "0.3,0.5,0.4,0.3");
    assert.equal(cropParam({ x: 1e-9, y: 0, width: 1, height: 1 }), "0,0,1,1");
    const [x, , w] = cropParam({ x: 0.3333335, y: 0, width: 0.6666665, height: 1 }).split(",").map(Number);
    assert.ok(x + w <= 1);
  });

  it("steps down through the sizes the endpoint accepts", () => {
    assert.equal(nextSmallerSize(1536), 1024);
    assert.equal(nextSmallerSize(1024), 768);
    assert.equal(nextSmallerSize(768), 512);
    assert.equal(nextSmallerSize(256), null);
  });
});

describe("adsoptimiser_view_image", () => {
  let stub;
  let other;
  let ctx;
  let state;
  before(async () => {
    stub = await startStub();
    // Another host: nothing may ever be requested from it.
    other = await startStub(() => ({ headers: { "content-type": "image/jpeg" }, body: JPEG }));
  });
  after(async () => {
    await stub.close();
    await other.close();
  });
  beforeEach(async () => {
    state = {
      originals: {
        job_img: { width: 3072, height: 4096 },
        "characters/amos-1.png": { width: 2048, height: 2048 },
        job_a2: { width: 1536, height: 1024 },
        "images/abc.png": { width: 800, height: 600 },
      },
    };
    stub.setHandler(makeApi(state, stub.url));
    ctx = await startClient(stub.url);
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    stub.requests.length = 0;
    other.requests.length = 0;
  });

  const thumbRequests = () => stub.requests.filter((r) => r.path === "/api/v1/media/thumbnail");

  it("returns one text block then exactly one image block, at 1024px by default", async () => {
    const res = await callRaw(ctx, { job_id: "job_img" });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.content.map((c) => c.type), ["text", "image"]);
    assert.equal(res.images[0].mimeType, "image/jpeg");
    assert.match(res.text, /Viewing job job_img\./);
    assert.match(res.text, /Returned 768 x 1024 \(size 1024\); original 3072 x 4096\./);
    assert.match(res.text, /Use crop to zoom into a region, e\.g\. \{ x: 0\.3, y: 0\.5, width: 0\.4, height: 0\.3 \}/);
    assert.deepEqual(res.structured, {
      source: { type: "job", job_id: "job_img" },
      width: 768,
      height: 1024,
      original_width: 3072,
      original_height: 4096,
      crop: null,
      size: 1024,
      mime_type: "image/jpeg",
    });
    const [req] = thumbRequests();
    assert.equal(req.url.searchParams.get("job_id"), "job_img");
    assert.equal(req.url.searchParams.get("size"), "1024");
    assert.equal(req.url.searchParams.has("crop"), false);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  });

  it("views by key, at the size asked for, never upscaled", async () => {
    const res = await callRaw(ctx, { key: "images/abc.png", size: 1536 });
    assert.equal(res.isError, false, res.text);
    assert.equal(thumbRequests()[0].url.searchParams.get("key"), "images/abc.png");
    assert.equal(thumbRequests()[0].url.searchParams.get("size"), "1536");
    assert.equal(res.structured.width, 800);
    assert.equal(res.structured.height, 600);
    assert.deepEqual(res.structured.source, { type: "key", key: "images/abc.png" });
  });

  it("maps crop to crop=x,y,w,h and reports it", async () => {
    const crop = { x: 0.3, y: 0.5, width: 0.4, height: 0.3 };
    const res = await callRaw(ctx, { job_id: "job_img", size: 768, crop });
    assert.equal(res.isError, false, res.text);
    assert.equal(thumbRequests()[0].url.searchParams.get("crop"), "0.3,0.5,0.4,0.3");
    assert.deepEqual(res.structured.crop, crop);
    assert.match(res.text, /Crop: x 0\.3, y 0\.5, width 0\.4, height 0\.3 of the original\./);
    // 1229 x 1229 crop of the original, scaled to 768.
    assert.equal(res.structured.width, 768);
  });

  it("says the original size is unknown when the server does not send it", async () => {
    state.hideOriginal = true;
    const res = await callRaw(ctx, { job_id: "job_img" });
    assert.equal(res.structured.original_width, null);
    assert.match(res.text, /original size unknown/);
  });

  describe("input checks (nothing is fetched)", () => {
    const refused = [
      [{}, /exactly one of job_id, key, or character_id/],
      [{ job_id: "job_img", key: "images/abc.png" }, /exactly one/],
      [{ job_id: "job_img", character_id: "chr_amos", image_index: 1 }, /exactly one/],
      [{ character_id: "chr_amos" }, /needs image_index/],
      [{ job_id: "job_img", image_index: 2 }, /image_index only applies with character_id/],
      [{ job_id: "job_img", crop: { x: 0.7, y: 0, width: 0.4, height: 0.5 } }, /Invalid crop: crop\.x \+ crop\.width must not exceed 1/],
      [{ job_id: "job_img", crop: { x: 0, y: 0, width: 0.01, height: 0.5 } }, /at least 0\.05/],
      [{ job_id: "job_img", save_to: "../outside" }, /contains "\.\."/],
    ];
    for (const [args, pattern] of refused) {
      it(`refuses ${JSON.stringify(args)}`, async () => {
        const res = await callRaw(ctx, args);
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.equal(stub.requests.length, 0);
      });
    }

    for (const args of [
      { job_id: "job_img", size: 512 },
      { job_id: "job_img", crop: { x: 1.2, y: 0, width: 0.5, height: 0.5 } },
      { character_id: "chr_amos", image_index: 6 },
    ]) {
      it(`schema refuses ${JSON.stringify(args)}`, async () => {
        const res = await callRaw(ctx, args);
        assert.equal(res.isError, true);
        assert.equal(stub.requests.length, 0);
      });
    }
  });

  describe("character images", () => {
    it("views this deployment's /media image by key", async () => {
      const res = await callRaw(ctx, { character_id: "chr_amos", image_index: 1 });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(stub.requests.map((r) => r.path), ["/api/v1/characters/chr_amos", "/api/v1/media/thumbnail"]);
      const q = thumbRequests()[0].url.searchParams;
      assert.equal(q.get("key"), "characters/amos-1.png");
      assert.equal(q.has("job_id"), false);
      assert.deepEqual(res.structured.source, {
        type: "character",
        character_id: "chr_amos",
        image_index: 1,
        key: "characters/amos-1.png",
      });
      assert.match(res.text, /reference image 1 of character Amos \(chr_amos\)/);
    });

    it("falls back to the source job for an image hosted elsewhere, without fetching it", async () => {
      const res = await callRaw(ctx, { character_id: "chr_amos", image_index: 2 });
      assert.equal(res.isError, false, res.text);
      assert.equal(thumbRequests()[0].url.searchParams.get("job_id"), "job_a2");
      assert.equal(res.structured.source.job_id, "job_a2");
      assert.equal(other.requests.length, 0);
    });

    it("explains an external URL with no job and fetches nothing", async () => {
      const res = await callRaw(ctx, { character_id: "chr_amos", image_index: 3 });
      assert.equal(res.isError, true);
      assert.match(res.text, /external URL \(https:\/\/cdn\.example\.com\/amos-3\.png\)/);
      assert.equal(thumbRequests().length, 0);
    });

    it("says how many images the character has when the index is past the end", async () => {
      const res = await callRaw(ctx, { character_id: "chr_amos", image_index: 5 });
      assert.equal(res.isError, true);
      assert.match(res.text, /has 3 reference image\(s\); image_index must be 1 to 3/);
      assert.equal(thumbRequests().length, 0);
    });

    it("reports an unknown character", async () => {
      const res = await callRaw(ctx, { character_id: "chr_ghost", image_index: 1 });
      assert.equal(res.isError, true);
      assert.match(res.text, /Not found/);
    });
  });

  describe("byte budget", () => {
    // Base64 of n bytes is 4 * ceil(n / 3) characters.
    const overBudget = Math.ceil((VIEW_IMAGE_MAX_IMAGE_BYTES / 4) * 3) + 3;

    it("retries once at the next smaller size and says so", async () => {
      state.bytesAt = (size) => (size === 1536 ? overBudget : 32);
      const res = await callRaw(ctx, { job_id: "job_img", size: 1536 });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(thumbRequests().map((r) => r.url.searchParams.get("size")), ["1536", "1024"]);
      assert.equal(res.images.length, 1);
      assert.equal(res.structured.size, 1024);
      assert.equal(res.structured.requested_size, 1536);
      assert.match(res.text, /At 1536px the image was over the 2,000,000-byte limit, so it was fetched again at 1024px\./);
    });

    it("keeps the crop on the retry", async () => {
      state.bytesAt = (size) => (size === 1024 ? overBudget : 32);
      const res = await callRaw(ctx, { job_id: "job_img", crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(thumbRequests().map((r) => r.url.searchParams.get("crop")), ["0.1,0.1,0.5,0.5", "0.1,0.1,0.5,0.5"]);
      assert.equal(res.structured.size, 768);
    });

    it("attaches nothing when the smaller size is still too big", async () => {
      state.bytesAt = () => overBudget;
      const res = await callRaw(ctx, { job_id: "job_img" });
      assert.equal(res.isError, false, res.text);
      assert.equal(thumbRequests().length, 2);
      assert.deepEqual(res.content.map((c) => c.type), ["text"]);
      assert.match(res.text, /still over 2,000,000 bytes \(base64\) at 768px, so it is not attached/);
      assert.equal(res.structured.attached, false);
    });

    it("an image exactly at the budget is attached without a retry", async () => {
      state.bytesAt = () => (VIEW_IMAGE_MAX_IMAGE_BYTES / 4) * 3; // base64 length exactly the budget
      const res = await callRaw(ctx, { job_id: "job_img" });
      assert.equal(thumbRequests().length, 1);
      assert.equal(res.images.length, 1);
    });
  });

  describe("errors", () => {
    const cases = [
      [{ status: 404, json: { code: "not_found", error: "No such job" } }, /not found in this workspace/],
      [{ status: 409, json: { code: "job_not_ready", error: "Job is generating" } }, /not finished yet.*adsoptimiser_get_job/],
      [{ status: 415, json: { code: "not_an_image", error: "That is a video" } }, /it is not an image \(That is a video\)/],
      [{ status: 400, json: { code: "invalid_crop", error: "crop out of range" } }, /the crop was refused \(crop out of range\)/],
      [{ status: 422, json: { code: "thumbnail_unavailable", reason: "transform_not_configured", error: "x" } }, /can't resize images right now/],
      [{ status: 422, json: { code: "thumbnail_unavailable", reason: "transform_failed", error: "x" } }, /could not be resized/],
      [{ status: 422, json: { code: "thumbnail_unavailable", reason: "video_without_poster", error: "x" } }, /video with no poster frame/],
      [{ status: 401, json: { code: "token_revoked", error: "revoked" } }, /no longer valid/],
    ];
    for (const [reply, pattern] of cases) {
      it(`${reply.status} ${reply.json.reason ?? reply.json.code} is a clear tool error`, async () => {
        state.error = () => reply;
        const res = await callRaw(ctx, { job_id: "job_img" });
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.equal(res.images.length, 0);
        assert.equal(res.structured.status, reply.status);
      });
    }

    it("refuses an answer that is not an image", async () => {
      state.contentType = "text/html";
      const res = await callRaw(ctx, { job_id: "job_img" });
      assert.equal(res.isError, true);
      assert.match(res.text, /not an image \(text\/html\)/);
    });
  });

  describe("older deployments", () => {
    const unsupported = `this Ads Optimiser deployment doesn't support view_image yet; previews in other tools are 384px`;
    it("uses the shared wording", () => {
      assert.equal(VIEW_IMAGE_UNSUPPORTED, unsupported);
    });

    it("400 invalid_size on a larger size", async () => {
      state.legacy = true;
      const res = await callRaw(ctx, { job_id: "job_img", size: 768 });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes(unsupported), res.text);
    });

    it("403 token_scope_denied", async () => {
      state.error = () => ({ status: 403, json: { code: "token_scope_denied", error: "Not for tokens" } });
      const res = await callRaw(ctx, { key: "images/abc.png" });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes(unsupported), res.text);
    });

    it("a 404 for a route that does not exist", async () => {
      state.error = () => ({ status: 404, json: { error: "Not found" } });
      const res = await callRaw(ctx, { job_id: "job_img" });
      assert.equal(res.isError, true);
      assert.ok(res.text.includes(unsupported), res.text);
    });
  });

  describe("save_to", () => {
    it("also saves the returned image with a numbered name, never replacing a file", async () => {
      const out = tempDir();
      try {
        const first = await callRaw(ctx, { job_id: "job_img", save_to: out.dir });
        const second = await callRaw(ctx, { job_id: "job_img", save_to: out.dir });
        assert.equal(first.isError, false, first.text);
        assert.deepEqual(readdirSync(out.dir).sort(), ["view-job_img-768x1024-2.jpg", "view-job_img-768x1024.jpg"]);
        assert.equal(first.structured.path, join(out.dir, "view-job_img-768x1024.jpg"));
        assert.match(second.text, /numbered name was used/);
        assert.deepEqual(readFileSync(first.structured.path).subarray(0, 4), JPEG.subarray(0, 4));
        // The image is still attached as well.
        assert.equal(first.images.length, 1);
      } finally {
        out.cleanup();
      }
    });

    it("names crops and character images apart", async () => {
      const out = tempDir();
      try {
        await callRaw(ctx, { character_id: "chr_amos", image_index: 1, save_to: out.dir, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } });
        assert.deepEqual(readdirSync(out.dir), ["view-chr_amos-1-1024x1024-crop.jpg"]);
      } finally {
        out.cleanup();
      }
    });
  });

  it("calls only its documented routes, and sends the token only to the API host", async () => {
    const out = tempDir();
    try {
      for (const args of [
        { job_id: "job_img" },
        { key: "images/abc.png", size: 768 },
        { character_id: "chr_amos", image_index: 1, save_to: out.dir },
        { character_id: "chr_amos", image_index: 2 },
        { character_id: "chr_amos", image_index: 3 },
      ]) {
        await callRaw(ctx, args);
      }
    } finally {
      out.cleanup();
    }
    assert.ok(stub.requests.length > 0);
    for (const r of stub.requests) {
      const route = `${r.method} ${r.path.replace(/^\/api\/v1\/characters\/[^/]+$/, "/api/v1/characters/:character_id")}`;
      assert.ok(TOOL_ROUTES[TOOL].includes(route), `view_image called ${route}`);
      assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    }
    assert.equal(other.requests.length, 0);
  });
});
