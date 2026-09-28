// Preview images (include_thumbnails): image blocks from GET
// /api/v1/media/thumbnail attached after the text, with the connector's
// limits, budgets and notes, and the older-deployment fallback.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEWS_UNSUPPORTED,
  THUMBNAIL_BUDGET_BYTES,
  THUMBNAIL_LIMITS,
  THUMBNAIL_MAX_IMAGE_BYTES,
  THUMBNAIL_SIZE,
  attachThumbnails,
  mediaKeyFromUrl,
} from "../src/thumbnails.mjs";
import { ApiError } from "../src/api.mjs";
import { TOKEN, startClient, startStub } from "./helpers.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

const image = (id, extra = {}) => ({
  job_id: id,
  asset_type: "image",
  status: "ready",
  model: "grok-imagine-image-2.0",
  prompt: `prompt ${id}`,
  storage_uri: `images/${id}.png`,
  ...extra,
});
const video = (id, extra = {}) => ({
  ...image(id),
  asset_type: "video",
  model: "grok-imagine-video",
  storage_uri: `videos/${id}.mp4`,
  ...extra,
});

/**
 * The stub API. `state.jobs` maps job ids to jobs; `state.thumb(params)` may
 * answer a thumbnail request (default: a small JPEG per id or key).
 */
function makeApi(state, origin) {
  return (r) => {
    const route = `${r.method} ${r.path}`;
    if (route === "GET /api/v1/media/thumbnail") {
      const q = Object.fromEntries(r.url.searchParams);
      const custom = state.thumb?.(q);
      if (custom) return custom;
      return {
        headers: { "content-type": "image/jpeg", "x-thumbnail-source": "transformed" },
        body: Buffer.concat([JPEG, Buffer.from(q.job_id ?? q.key ?? "")]),
      };
    }
    if (route === "POST /api/v1/jobs") {
      return { status: 201, json: { ...image("job_new"), status: "queued", storage_uri: null } };
    }
    const jobMatch = /^GET \/api\/v1\/jobs\/([^/]+)$/.exec(route);
    if (jobMatch && state.jobs?.[jobMatch[1]]) return { json: state.jobs[jobMatch[1]] };
    if (route === "GET /api/v1/jobs") {
      const jobs = Object.values(state.jobs ?? {});
      return { json: { jobs, total: jobs.length } };
    }
    if (route === "GET /api/v1/characters/chr_amos") {
      return {
        json: {
          character_id: "chr_amos",
          name: "Amos",
          images: state.characterImages ?? [
            { url: `${origin}/media/${encodeURIComponent("characters/amos-1.png")}`, job_id: "job_a" },
            { url: "https://cdn.example.com/amos-2.png", job_id: "job_b" },
          ],
        },
      };
    }
    if (route === "GET /api/v1/characters/chr_amos/assets") {
      return { json: { character_id: "chr_amos", items: state.assetItems ?? [], counts: { image: 1 }, next_cursor: null } };
    }
    if (route === "GET /api/v1/characters/chr_amos/voice-previews") return { json: { previews: [] } };
    return undefined;
  };
}

/** A tool call with its raw content blocks. */
async function callRaw(ctx, name, args = {}) {
  const result = await ctx.client.callTool({ name, arguments: args });
  const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
  const images = result.content.filter((c) => c.type === "image");
  return { result, content: result.content, texts, text: texts.join("\n"), images, isError: result.isError === true };
}

describe("preview images", () => {
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
    state = { jobs: {} };
    stub.setHandler(makeApi(state, stub.url));
    ctx = await startClient(stub.url, { imageWaitSeconds: 3, pollIntervalMs: 3000 });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    stub.requests.length = 0;
    other.requests.length = 0;
  });

  const thumbRequests = () => stub.requests.filter((r) => r.path === "/api/v1/media/thumbnail");

  describe("get_job", () => {
    it("attaches the finished image after the text, as a JPEG block, by default", async () => {
      state.jobs.job_img = image("job_img");
      const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_img" });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(res.content.map((c) => c.type), ["text", "text", "image"]);
      assert.equal(res.content[1].text, `Attached 1 preview image(s) (${THUMBNAIL_SIZE}px), in order: 1) job job_img.`);
      assert.equal(res.images[0].mimeType, "image/jpeg");
      assert.equal(res.images[0].data, Buffer.concat([JPEG, Buffer.from("job_img")]).toString("base64"));
      const [req] = thumbRequests();
      assert.equal(req.url.searchParams.get("job_id"), "job_img");
      assert.equal(req.url.searchParams.get("size"), "384");
      assert.equal(req.url.searchParams.has("key"), false);
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.match(req.headers.accept, /image\/\*/);
    });

    it("leaves the structured content unchanged", async () => {
      state.jobs.job_img = image("job_img");
      const withPreview = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_img" });
      const without = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_img", include_thumbnails: false });
      assert.deepEqual(withPreview.result.structuredContent, without.result.structuredContent);
      assert.equal(JSON.stringify(withPreview.result.structuredContent).includes("base64"), false);
    });

    it("include_thumbnails false fetches nothing", async () => {
      state.jobs.job_img = image("job_img");
      const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_img", include_thumbnails: false });
      assert.equal(res.images.length, 0);
      assert.equal(res.content.length, 1);
      assert.equal(thumbRequests().length, 0);
    });

    it("a video without a poster frame is a note, not a request", async () => {
      state.jobs.job_vid = video("job_vid");
      const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_vid" });
      assert.equal(res.isError, false);
      assert.equal(thumbRequests().length, 0);
      assert.equal(res.images.length, 0);
      assert.equal(
        res.content[1].text,
        "No preview images attached.\nNot previewed: job job_vid: videos are not previewed unless a poster frame is stored; open its media URL to watch it."
      );
    });

    it("a video with a stored poster frame is previewed", async () => {
      state.jobs.job_vid = video("job_vid", { thumbnail_uri: "thumbs/job_vid.jpg" });
      const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_vid" });
      assert.equal(res.images.length, 1);
      assert.match(res.text, /in order: 1\) job job_vid \(poster frame\)\./);
      assert.equal(thumbRequests()[0].url.searchParams.get("job_id"), "job_vid");
    });

    for (const status of ["queued", "generating", "failed", "expired"]) {
      it(`a ${status} job has no preview and no note`, async () => {
        state.jobs.job_x = image("job_x", { status, storage_uri: status === "expired" ? "images/x.png" : null });
        const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "job_x" });
        assert.equal(res.content.length, 1);
        assert.equal(thumbRequests().length, 0);
      });
    }
  });

  describe("generate_image", () => {
    it("attaches the finished image by default", async () => {
      state.jobs.job_new = image("job_new");
      const res = await callRaw(ctx, "adsoptimiser_generate_image", { prompt: "A red sneaker" });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(res.content.map((c) => c.type), ["text", "text", "image"]);
      assert.match(res.content[0].text, /Save it locally with adsoptimiser_download_job/);
      assert.match(res.content[1].text, /1\) job job_new\./);
    });

    it("include_thumbnails false, or a job still generating, fetches nothing", async () => {
      state.jobs.job_new = image("job_new");
      const off = await callRaw(ctx, "adsoptimiser_generate_image", { prompt: "x", include_thumbnails: false });
      assert.equal(off.content.length, 1);
      const queued = await callRaw(ctx, "adsoptimiser_generate_image", { prompt: "x", wait: false });
      assert.equal(queued.content.length, 1);
      assert.match(queued.text, /Still generating/);
      assert.equal(thumbRequests().length, 0);
    });
  });

  describe("list_jobs", () => {
    it("attaches nothing by default", async () => {
      state.jobs = { a: image("a"), b: image("b") };
      const res = await callRaw(ctx, "adsoptimiser_list_jobs");
      assert.equal(res.content.length, 1);
      assert.equal(thumbRequests().length, 0);
    });

    it(`with include_thumbnails previews at most ${THUMBNAIL_LIMITS.list_jobs} finished jobs, in order`, async () => {
      for (let i = 1; i <= 8; i++) state.jobs[`img_${i}`] = image(`img_${i}`);
      state.jobs.vid_plain = video("vid_plain");
      state.jobs.vid_poster = video("vid_poster", { thumbnail_uri: "thumbs/p.jpg" });
      state.jobs.queued = image("queued", { status: "queued", storage_uri: null });
      const res = await callRaw(ctx, "adsoptimiser_list_jobs", { include_thumbnails: true, limit: 20 });
      assert.equal(res.isError, false);
      assert.equal(res.images.length, 6);
      assert.equal(thumbRequests().length, 6);
      assert.deepEqual(res.content.map((c) => c.type), ["text", "text", ...Array(6).fill("image")]);
      assert.equal(
        res.content[1].text,
        `Attached 6 preview image(s) (384px), in order: ${[1, 2, 3, 4, 5, 6].map((i) => `${i}) job img_${i}`).join("; ")}.\n` +
          "Not previewed: 1 video(s) without a poster frame (videos are not previewed otherwise); 3 more not previewed (at most 6 per call)."
      );
      res.images.forEach((img, i) => {
        assert.equal(img.data, Buffer.concat([JPEG, Buffer.from(`img_${i + 1}`)]).toString("base64"));
      });
    });
  });

  describe("budgets", () => {
    it(`drops an image over ${THUMBNAIL_MAX_IMAGE_BYTES} base64 bytes`, async () => {
      state.jobs.big = image("big");
      const raw = Math.ceil((THUMBNAIL_MAX_IMAGE_BYTES + 4) * 0.75);
      state.thumb = () => ({ headers: { "content-type": "image/jpeg" }, body: Buffer.alloc(raw, 1) });
      const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "big" });
      assert.equal(res.isError, false);
      assert.equal(res.images.length, 0);
      assert.equal(res.content[1].text, "No preview images attached.\nNot previewed: job big: left out to keep the result small.");
    });

    it(`keeps a result under ${THUMBNAIL_BUDGET_BYTES} base64 bytes in total`, async () => {
      for (const id of ["a", "b", "c", "d"]) state.jobs[id] = image(id);
      // 540,000 base64 bytes each: two fit, the third would pass the budget.
      state.thumb = () => ({ headers: { "content-type": "image/jpeg" }, body: Buffer.alloc(405_000, 7) });
      const res = await callRaw(ctx, "adsoptimiser_list_jobs", { include_thumbnails: true });
      assert.equal(res.images.length, 2);
      const total = res.images.reduce((n, img) => n + img.data.length, 0);
      assert.ok(total <= THUMBNAIL_BUDGET_BYTES);
      assert.match(res.content[1].text, /^Attached 2 preview image\(s\) \(384px\), in order: 1\) job a; 2\) job b\./);
      assert.match(res.content[1].text, /Not previewed: job c: left out to keep the result small; job d: left out to keep the result small\.$/);
    });

    it("names an answer that is not an image", async () => {
      state.jobs = { a: image("a"), b: image("b") };
      state.thumb = (q) =>
        q.job_id === "a"
          ? { headers: { "content-type": "text/html" }, body: "<html></html>" }
          : { headers: { "content-type": "image/png" }, body: Buffer.alloc(0) };
      const res = await callRaw(ctx, "adsoptimiser_list_jobs", { include_thumbnails: true });
      assert.equal(res.images.length, 0);
      assert.match(res.text, /Not previewed: job a: not an image; job b: not an image\./);
    });

    it("keeps the served mime type", async () => {
      state.jobs.a = image("a");
      state.thumb = () => ({ headers: { "content-type": "image/png; charset=binary" }, body: JPEG });
      const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "a" });
      assert.equal(res.images[0].mimeType, "image/png");
    });
  });

  describe("errors become notes", () => {
    const cases = [
      ["422 video_without_poster", { status: 422, json: { error: "no poster", code: "thumbnail_unavailable", reason: "video_without_poster" } }, "video has no poster frame"],
      ["422 transform_failed", { status: 422, json: { error: "x", code: "thumbnail_unavailable", reason: "transform_failed" } }, "preview unavailable right now"],
      ["422 transform_not_configured", { status: 422, json: { error: "x", code: "thumbnail_unavailable", reason: "transform_not_configured" } }, "preview unavailable right now"],
      ["409 job_not_ready", { status: 409, json: { error: "Job is generating", code: "job_not_ready" } }, "job_not_ready"],
      ["415 not_an_image", { status: 415, json: { error: "Only images", code: "not_an_image" } }, "not_an_image"],
      ["404 not_found", { status: 404, json: { error: "Job not found", code: "not_found" } }, "not found"],
      ["500 without a code", { status: 500, json: { error: "Upstream failed" } }, "HTTP 500"],
    ];
    for (const [label, reply, note] of cases) {
      it(`${label}: "${note}", and the tool still succeeds`, async () => {
        state.jobs.a = image("a");
        state.thumb = () => reply;
        const res = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "a" });
        assert.equal(res.isError, false, res.text);
        assert.equal(res.result.structuredContent.status, "ready");
        assert.equal(res.images.length, 0);
        assert.equal(res.content[1].text, `No preview images attached.\nNot previewed: job a: ${note}.`);
      });
    }

    it("one failure does not stop the other previews", async () => {
      state.jobs = { a: image("a"), b: image("b") };
      state.thumb = (q) => (q.job_id === "a" ? { status: 500, json: { error: "Upstream failed" } } : undefined);
      const res = await callRaw(ctx, "adsoptimiser_list_jobs", { include_thumbnails: true });
      assert.equal(res.images.length, 1);
      assert.equal(res.content[1].text, "Attached 1 preview image(s) (384px), in order: 1) job b.\nNot previewed: job a: HTTP 500.");
    });
  });

  describe("older deployments", () => {
    const older = [
      ["403 token_scope_denied", { status: 403, json: { error: "Not available to API tokens", code: "token_scope_denied" } }],
      ["404 (no thumbnail route)", { status: 404, json: { error: "Not found" } }],
      ["404 with a non-JSON body", { status: 404, body: "Not Found" }],
    ];
    for (const [label, reply] of older) {
      it(`${label} degrades to one note and never fails the tool`, async () => {
        state.jobs = { a: image("a"), b: image("b"), c: image("c") };
        state.thumb = () => reply;
        const res = await callRaw(ctx, "adsoptimiser_list_jobs", { include_thumbnails: true });
        assert.equal(res.isError, false, res.text);
        assert.equal(res.images.length, 0);
        assert.equal(res.content[1].text, `No preview images attached.\nNot previewed: ${PREVIEWS_UNSUPPORTED}.`);
        const one = await callRaw(ctx, "adsoptimiser_get_job", { job_id: "a" });
        assert.equal(one.isError, false);
        assert.match(one.text, /this Ads Optimiser deployment doesn't serve previews yet/);
      });
    }
  });

  describe("get_character", () => {
    it("previews reference images by key (own media) or job, and never asks another host", async () => {
      state.characterImages = [
        { url: `${stub.url}/media/${encodeURIComponent("characters/amos-1.png")}`, job_id: "job_a" },
        { url: `${other.url}/media/amos-2.png`, job_id: "job_b" },
        { url: `${other.url}/media/amos-3.png`, job_id: null },
      ];
      const res = await callRaw(ctx, "adsoptimiser_get_character", { character_id: "chr_amos" });
      assert.equal(res.isError, false, res.text);
      const thumbs = thumbRequests().map((r) => Object.fromEntries(r.url.searchParams));
      assert.deepEqual(thumbs, [
        { size: "384", key: "characters/amos-1.png" },
        { size: "384", job_id: "job_b" },
      ]);
      assert.equal(other.requests.length, 0, "nothing is fetched from another host");
      for (const r of thumbRequests()) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(res.images.length, 2);
      const note = res.texts.at(-1);
      assert.equal(
        note,
        "Attached 2 preview image(s) (384px), in order: 1) reference image 1; 2) reference image 2.\nNot previewed: reference image 3: external URL."
      );
      assert.equal(res.content.findIndex((c) => c.type === "image"), res.content.length - 2);
    });

    it(`previews at most ${THUMBNAIL_LIMITS.get_character} and is on by default`, async () => {
      state.characterImages = Array.from({ length: 6 }, (_, i) => ({
        url: `${stub.url}/media/c${i}.png`,
        job_id: null,
      }));
      const res = await callRaw(ctx, "adsoptimiser_get_character", { character_id: "chr_amos" });
      assert.equal(res.images.length, 5);
      assert.match(res.texts.at(-1), /Not previewed: 1 more not previewed \(at most 5 per call\)\./);
    });

    it("include_thumbnails false fetches nothing", async () => {
      const res = await callRaw(ctx, "adsoptimiser_get_character", { character_id: "chr_amos", include_thumbnails: false });
      assert.equal(res.images.length, 0);
      assert.equal(thumbRequests().length, 0);
      assert.equal(res.content.length, 1);
    });

    it("the character still answers when previews fail", async () => {
      state.thumb = () => ({ status: 403, json: { error: "no", code: "token_scope_denied" } });
      const res = await callRaw(ctx, "adsoptimiser_get_character", { character_id: "chr_amos" });
      assert.equal(res.isError, false);
      assert.equal(res.result.structuredContent.character_id, "chr_amos");
      assert.match(res.texts.at(-1), /doesn't serve previews yet/);
    });
  });

  describe("list_character_assets", () => {
    const items = () => [
      { job_id: "img_1", kind: "image", asset_type: "image", status: "ready", media_url: `${stub.url}/media/i1.png` },
      { job_id: "vid_1", kind: "video", asset_type: "video", status: "ready", media_url: `${stub.url}/media/v1.mp4` },
      { job_id: "img_2", kind: "image", asset_type: "image", status: "generating", media_url: null },
      { job_id: "img_3", kind: "image", asset_type: "image", status: "ready", media_url: `${stub.url}/media/i3.png` },
    ];

    it("attaches nothing by default", async () => {
      state.assetItems = items();
      const res = await callRaw(ctx, "adsoptimiser_list_character_assets", { character_id: "chr_amos" });
      assert.equal(res.content.length, 1);
      assert.equal(thumbRequests().length, 0);
    });

    it("previews only finished images, and names the rest", async () => {
      state.assetItems = items();
      const res = await callRaw(ctx, "adsoptimiser_list_character_assets", { character_id: "chr_amos", include_thumbnails: true });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(thumbRequests().map((r) => r.url.searchParams.get("job_id")), ["img_1", "img_3"]);
      assert.equal(res.images.length, 2);
      assert.equal(
        res.content[1].text,
        "Attached 2 preview image(s) (384px), in order: 1) job img_1; 2) job img_3.\nNot previewed: 2 video or unfinished item(s) (only finished images are previewed)."
      );
    });

    it("works alongside download_to", async () => {
      state.assetItems = items().slice(0, 1);
      const base = makeApi(state, stub.url);
      stub.setHandler((r) =>
        r.path.startsWith("/media/") ? { headers: { "content-type": "image/png" }, body: JPEG } : base(r)
      );
      const res = await callRaw(ctx, "adsoptimiser_list_character_assets", {
        character_id: "chr_amos",
        include_thumbnails: true,
        download_to: "",
      });
      assert.equal(res.isError, false, res.text);
      assert.match(res.content[0].text, /Saved 1 file\(s\)/);
      assert.equal(res.images.length, 1);
      const media = stub.requests.find((r) => r.path.startsWith("/media/"));
      assert.equal(media.headers.authorization, undefined);
    });
  });

  describe("tool schemas", () => {
    it("offer include_thumbnails with the connector's defaults", async () => {
      const { tools } = await ctx.client.listTools();
      const expected = {
        adsoptimiser_get_job: true,
        adsoptimiser_generate_image: true,
        adsoptimiser_get_character: true,
        adsoptimiser_list_jobs: false,
        adsoptimiser_list_character_assets: false,
      };
      for (const [name, def] of Object.entries(expected)) {
        const prop = tools.find((t) => t.name === name).inputSchema.properties.include_thumbnails;
        assert.equal(prop?.type, "boolean", name);
        assert.match(prop.description, new RegExp(`Default ${def}\\.$`), name);
      }
      const withFlag = tools.filter((t) => t.inputSchema.properties?.include_thumbnails).map((t) => t.name);
      assert.deepEqual(withFlag.sort(), Object.keys(expected).sort());
    });
  });
});

describe("attachThumbnails", () => {
  const base = { content: [{ type: "text", text: "Job a" }] };
  it("turns timeouts, network failures and unexpected errors into notes", async () => {
    const failures = {
      t: new ApiError(0, "timeout", "did not answer in time"),
      n: new ApiError(0, "network_error", "could not reach"),
      x: new Error("boom"),
    };
    const api = {
      requestBinary: async (path) => {
        throw failures[new URL(path, "http://x").searchParams.get("job_id")];
      },
    };
    const targets = ["t", "n", "x"].map((id) => ({ label: `job ${id}`, job_id: id }));
    const out = await attachThumbnails(api, base, targets, 3);
    assert.deepEqual(out.content.map((c) => c.type), ["text", "text"]);
    assert.equal(
      out.content[1].text,
      "No preview images attached.\nNot previewed: job t: timeout; job n: network_error; job x: preview failed."
    );
  });

  it("returns the result untouched when there is nothing to preview or note", async () => {
    const api = { requestBinary: async () => assert.fail("no request expected") };
    assert.equal(await attachThumbnails(api, base, [], 1), base);
  });
});

describe("mediaKeyFromUrl", () => {
  const base = "https://api.example.test";
  it("reads the key from this deployment's /media URLs only", () => {
    assert.equal(mediaKeyFromUrl(base, `${base}/media/${encodeURIComponent("a/b c.png")}`), "a/b c.png");
    assert.equal(mediaKeyFromUrl(base, `${base}/api/media/x.png`), "x.png");
    assert.equal(mediaKeyFromUrl(base, "https://evil.example.com/media/x.png"), null);
    assert.equal(mediaKeyFromUrl(base, "http://api.example.test/media/x.png"), null);
    assert.equal(mediaKeyFromUrl(base, `${base}/other/x.png`), null);
    assert.equal(mediaKeyFromUrl(base, "not a url"), null);
  });
});
