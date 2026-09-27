import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, downloadFileName, slugify } from "../src/files.mjs";
import { MAX_BATCH_ITEMS } from "../src/server.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const MP4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const VIDEO_BYTES = Buffer.from("fake mp4 bytes");

function makeApi(state) {
  let uploads = 0;
  let jobs = 0;
  return async (r) => {
    const route = `${r.method} ${r.path}`;
    if (route === "POST /api/v1/jobs/source-media") {
      uploads += 1;
      return {
        json: {
          success: true,
          source_type: "image",
          key: `sources/images/src_${uploads}_x.png`,
          source_url: `https://api.example.test/media/sources%2Fimages%2Fsrc_${uploads}_x.png`,
          bytes: 16,
        },
      };
    }
    if (route === "POST /api/v1/jobs") {
      jobs += 1;
      if (state.planLimitAfter !== undefined && jobs > state.planLimitAfter) {
        return {
          status: 429,
          json: { error: "Monthly generation limit reached.", code: "plan_limit_exceeded" },
        };
      }
      const body = JSON.parse(r.body.toString());
      if (state.rejectPrompt && body.prompt === state.rejectPrompt) {
        return { status: 400, json: { error: "prompt was refused by moderation" } };
      }
      return { status: 201, json: { job_id: `job_${jobs}`, asset_type: body.asset_type, status: "queued" } };
    }
    if (route === "GET /api/v1/jobs/job_vid") {
      return {
        json: {
          job_id: "job_vid",
          asset_type: "video",
          status: "ready",
          prompt: "Sneaker spins on a pink podium! ../../etc",
          storage_uri: "videos/job_vid.mp4",
        },
      };
    }
    if (route === "GET /api/v1/jobs/job_busy") {
      return { json: { job_id: "job_busy", asset_type: "video", status: "generating" } };
    }
    if (route === "GET /media/videos%2Fjob_vid.mp4") {
      return { headers: { "content-type": "video/mp4" }, body: VIDEO_BYTES };
    }
    return undefined;
  };
}

describe("local file tools", () => {
  let stub;
  let ctx;
  let work;
  let state;
  before(async () => {
    stub = await startStub();
  });
  after(async () => {
    await stub.close();
  });
  beforeEach(async () => {
    state = {};
    stub.setHandler(makeApi(state));
    work = tempDir("adsopt-work-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    work.cleanup();
    stub.requests.length = 0;
  });

  const uploads = () => stub.requests.filter((r) => r.path === "/api/v1/jobs/source-media");
  const jobPosts = () => stub.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/jobs");

  describe("adsoptimiser_upload_file", () => {
    it("uploads multipart with the file, its type and source_type, and returns the hosted URL", async () => {
      const file = join(work.dir, "hero shot.png");
      writeFileSync(file, PNG);
      const res = await ctx.call("adsoptimiser_upload_file", { path: file });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /URL: https:\/\/api.example.test\/media\//);
      assert.equal(res.structured.source_url, "https://api.example.test/media/sources%2Fimages%2Fsrc_1_x.png");

      const [req] = uploads();
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
      const form = await stub.formData(req);
      assert.equal(form.get("source_type"), "image");
      assert.equal(form.get("purpose"), null);
      const sent = form.get("file");
      assert.equal(sent.name, "hero shot.png");
      assert.equal(sent.type, "image/png");
      assert.deepEqual(Buffer.from(await sent.arrayBuffer()), PNG);
    });

    it("uses the real image type when the extension lies, and sends videos with purpose", async () => {
      const jpegNamedPng = join(work.dir, "actually-jpeg.png");
      writeFileSync(jpegNamedPng, JPEG);
      await ctx.call("adsoptimiser_upload_file", { path: jpegNamedPng });
      assert.equal((await stub.formData(uploads()[0])).get("file").type, "image/jpeg");

      const clip = join(work.dir, "clip.mp4");
      writeFileSync(clip, MP4);
      await ctx.call("adsoptimiser_upload_file", { path: clip, purpose: "extend" });
      const form = await stub.formData(uploads()[1]);
      assert.equal(form.get("source_type"), "video");
      assert.equal(form.get("purpose"), "extend");
      assert.equal(form.get("file").type, "video/mp4");
    });

    it("resolves relative paths against the working directory", async () => {
      writeFileSync(join(work.dir, "rel.png"), PNG);
      const res = await ctx.call("adsoptimiser_upload_file", { path: "rel.png" });
      assert.equal(res.isError, false, res.text);
    });

    const invalid = [
      ["a missing file", () => join(work.dir, "nope.png"), /File not found/],
      ["a folder", () => work.dir, /is a folder/],
      [
        "an unsupported extension",
        () => {
          writeFileSync(join(work.dir, "notes.txt"), "hi");
          return join(work.dir, "notes.txt");
        },
        /unsupported file type/,
      ],
      [
        "a HEIC photo",
        () => {
          writeFileSync(join(work.dir, "phone.heic"), "x");
          return join(work.dir, "phone.heic");
        },
        /Convert it to JPEG or PNG/,
      ],
      [
        "an empty file",
        () => {
          writeFileSync(join(work.dir, "empty.png"), "");
          return join(work.dir, "empty.png");
        },
        /is empty/,
      ],
      [
        "text pretending to be an image",
        () => {
          writeFileSync(join(work.dir, "fake.png"), "not an image at all");
          return join(work.dir, "fake.png");
        },
        /does not look like/,
      ],
      [
        "an image over 10 MB",
        () => {
          const p = join(work.dir, "huge.png");
          writeFileSync(p, PNG);
          truncateSync(p, MAX_IMAGE_BYTES + 1); // sparse, instant
          return p;
        },
        /limit for images is 10.0 MB/,
      ],
    ];
    for (const [label, makePath, pattern] of invalid) {
      it(`refuses ${label} without calling the API`, async () => {
        const res = await ctx.call("adsoptimiser_upload_file", { path: makePath() });
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("refuses purpose extend for an image", async () => {
      writeFileSync(join(work.dir, "a.png"), PNG);
      const res = await ctx.call("adsoptimiser_upload_file", { path: join(work.dir, "a.png"), purpose: "extend" });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  });

  describe("local paths in generate tools", () => {
    it("generate_image uploads reference_image_paths and passes their URLs", async () => {
      writeFileSync(join(work.dir, "a.png"), PNG);
      writeFileSync(join(work.dir, "b.jpg"), JPEG);
      const res = await ctx.call("adsoptimiser_generate_image", {
        prompt: "Put these on a beach",
        reference_image_paths: [join(work.dir, "a.png"), join(work.dir, "b.jpg")],
        reference_image_urls: ["https://cdn.example.com/c.png"],
        wait: false,
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(uploads().length, 2);
      const body = JSON.parse(jobPosts()[0].body.toString());
      assert.deepEqual(body.generation_params.image_urls, [
        "https://cdn.example.com/c.png",
        "https://api.example.test/media/sources%2Fimages%2Fsrc_1_x.png",
        "https://api.example.test/media/sources%2Fimages%2Fsrc_2_x.png",
      ]);
    });

    it("generate_image checks every local file before uploading any", async () => {
      writeFileSync(join(work.dir, "a.png"), PNG);
      const res = await ctx.call("adsoptimiser_generate_image", {
        prompt: "x",
        reference_image_paths: [join(work.dir, "a.png"), join(work.dir, "missing.png")],
      });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });

    it("generate_video uploads source_image_path for image-to-video", async () => {
      writeFileSync(join(work.dir, "still.png"), PNG);
      const res = await ctx.call("adsoptimiser_generate_video", {
        prompt: "Make it move",
        source_image_path: join(work.dir, "still.png"),
      });
      assert.equal(res.isError, false, res.text);
      const body = JSON.parse(jobPosts()[0].body.toString());
      assert.equal(body.generation_params.image_url, "https://api.example.test/media/sources%2Fimages%2Fsrc_1_x.png");
    });

    it("generate_video refuses a video as source_image_path", async () => {
      writeFileSync(join(work.dir, "clip.mp4"), MP4);
      const res = await ctx.call("adsoptimiser_generate_video", {
        prompt: "x",
        source_image_path: join(work.dir, "clip.mp4"),
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /is a video, but an image is needed/);
    });
  });

  describe("adsoptimiser_download_job", () => {
    it("saves into ./adsoptimiser-output with a job id and prompt slug name, fetching media without the token", async () => {
      const res = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid" });
      assert.equal(res.isError, false, res.text);
      const expected = join(work.dir, "adsoptimiser-output", "job_vid-sneaker-spins-on-a-pink-podium-etc.mp4");
      assert.equal(res.structured.path, expected);
      assert.deepEqual(readFileSync(expected), VIDEO_BYTES);
      const media = stub.requests.find((r) => r.path.startsWith("/media/"));
      assert.equal(media.headers.authorization, undefined);
    });

    it("never overwrites silently: a second download gets a numbered name", async () => {
      await ctx.call("adsoptimiser_download_job", { job_id: "job_vid" });
      const second = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid" });
      assert.equal(second.structured.renamed, true);
      assert.match(second.structured.path, /-2\.mp4$/);
      assert.match(second.text, /numbered name/);
      assert.equal(readdirSync(join(work.dir, "adsoptimiser-output")).length, 2);

      const replaced = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid", overwrite: true });
      assert.equal(replaced.structured.renamed, false);
      assert.equal(readdirSync(join(work.dir, "adsoptimiser-output")).length, 2);
    });

    it("accepts a custom folder, relative or absolute", async () => {
      const abs = join(work.dir, "exports", "august");
      const res = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid", folder: abs });
      assert.equal(res.isError, false, res.text);
      assert.equal(readdirSync(abs).length, 1);
      const rel = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid", folder: "out" });
      assert.equal(rel.structured.path.startsWith(join(work.dir, "out")), true);
    });

    for (const folder of ["../escape", "out/../../escape", "..\\escape", "a/.."]) {
      it(`refuses the folder ${JSON.stringify(folder)} before any request`, async () => {
        const res = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid", folder });
        assert.equal(res.isError, true);
        assert.match(res.text, /contains "\.\."/);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("refuses a job that is not ready", async () => {
      const res = await ctx.call("adsoptimiser_download_job", { job_id: "job_busy" });
      assert.equal(res.isError, true);
      assert.match(res.text, /is generating; only ready jobs can be downloaded/);
    });

    it("rejects job ids that could form a path", async () => {
      const res = await ctx.call("adsoptimiser_download_job", { job_id: "../job" });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });

    it("uses ADSOPTIMISER_OUTPUT_DIR as the default folder", async () => {
      await ctx.close();
      const out = join(work.dir, "configured");
      ctx = await startClient(stub.url, { cwd: work.dir, env: { ADSOPTIMISER_OUTPUT_DIR: out } });
      ctx.connectToken();
      const res = await ctx.call("adsoptimiser_download_job", { job_id: "job_vid" });
      assert.equal(res.structured.path.startsWith(out), true);
    });
  });

  describe("adsoptimiser_batch_generate", () => {
    function imageFolder(count) {
      const dir = join(work.dir, "shots");
      mkdirSync(dir);
      for (let i = 1; i <= count; i++) writeFileSync(join(dir, `shot${i}.png`), PNG);
      writeFileSync(join(dir, "readme.txt"), "not an image");
      writeFileSync(join(dir, ".hidden.png"), PNG);
      return dir;
    }

    it("image_to_video queues one video per image, in name order", async () => {
      const dir = imageFolder(3);
      const res = await ctx.call("adsoptimiser_batch_generate", {
        mode: "image_to_video",
        folder: dir,
        prompt: "Slow push in",
        duration: 6,
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.structured.queued.length, 3);
      assert.equal(uploads().length, 3);
      const bodies = jobPosts().map((r) => JSON.parse(r.body.toString()));
      assert.deepEqual(
        bodies.map((b) => [b.asset_type, b.generation_params.image_url, b.generation_params.duration]),
        [1, 2, 3].map((n) => ["video", `https://api.example.test/media/sources%2Fimages%2Fsrc_${n}_x.png`, 6])
      );
      assert.deepEqual(
        res.structured.queued.map((q) => q.item),
        [1, 2, 3].map((n) => join(dir, `shot${n}.png`))
      );
      assert.equal(res.structured.next_offset, null);
    });

    it("image_edit sends each image as the single reference", async () => {
      const dir = imageFolder(2);
      await ctx.call("adsoptimiser_batch_generate", { mode: "image_edit", folder: dir, prompt: "Studio lighting" });
      const bodies = jobPosts().map((r) => JSON.parse(r.body.toString()));
      assert.deepEqual(bodies[0].generation_params.image_urls, [
        "https://api.example.test/media/sources%2Fimages%2Fsrc_1_x.png",
      ]);
      assert.equal(bodies[0].asset_type, "image");
    });

    it(`caps a call at ${MAX_BATCH_ITEMS} and says how to resume`, async () => {
      const dir = imageFolder(13);
      const res = await ctx.call("adsoptimiser_batch_generate", { mode: "image_edit", folder: dir, prompt: "x" });
      assert.equal(res.structured.queued.length, MAX_BATCH_ITEMS);
      assert.equal(jobPosts().length, MAX_BATCH_ITEMS);
      assert.equal(res.structured.next_offset, 10);
      assert.match(res.text, /3 item\(s\) not attempted.*offset 10/);

      const rest = await ctx.call("adsoptimiser_batch_generate", {
        mode: "image_edit",
        folder: dir,
        prompt: "x",
        offset: 10,
      });
      assert.equal(rest.structured.queued.length, 3);
      assert.equal(rest.structured.queued[0].item, join(dir, "shot11.png"));
    });

    it("stops at a plan limit and reports what was queued", async () => {
      state.planLimitAfter = 2;
      writeFileSync(join(work.dir, "prompts.txt"), "# ideas\nfirst\n\nsecond\nthird\nfourth\n");
      const res = await ctx.call("adsoptimiser_batch_generate", {
        mode: "prompts",
        prompts_file: join(work.dir, "prompts.txt"),
      });
      assert.equal(res.structured.queued.length, 2);
      assert.equal(res.structured.stopped.code, "plan_limit_exceeded");
      assert.equal(jobPosts().length, 3); // the third was refused, the fourth never sent
      assert.match(res.text, /Stopped at line 3: Plan limit reached/);
      assert.match(res.text, /https:\/\/app.example.test\/#\/billing/);
      assert.equal(res.structured.next_offset, 2);
    });

    it("skips a single rejected item and carries on", async () => {
      state.rejectPrompt = "second";
      writeFileSync(join(work.dir, "prompts.txt"), "first\nsecond\nthird\n");
      const res = await ctx.call("adsoptimiser_batch_generate", {
        mode: "prompts",
        prompts_file: join(work.dir, "prompts.txt"),
        asset_type: "video",
      });
      assert.equal(res.structured.queued.length, 2);
      assert.equal(res.structured.failed.length, 1);
      assert.match(res.structured.failed[0].reason, /moderation/);
      assert.equal(JSON.parse(jobPosts()[0].body.toString()).generation_params.aspect_ratio, "9:16");
    });

    it("validates the mode's inputs", async () => {
      const noFolder = await ctx.call("adsoptimiser_batch_generate", { mode: "image_edit", prompt: "x" });
      assert.equal(noFolder.isError, true);
      const noPrompt = await ctx.call("adsoptimiser_batch_generate", { mode: "image_edit", folder: work.dir });
      assert.equal(noPrompt.isError, true);
      const empty = await ctx.call("adsoptimiser_batch_generate", {
        mode: "image_to_video",
        folder: work.dir,
        prompt: "x",
      });
      assert.match(empty.text, /no usable items/);
      const tooMany = await ctx.call("adsoptimiser_batch_generate", {
        mode: "prompts",
        prompts_file: "p.txt",
        max_items: 11,
      });
      assert.equal(tooMany.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  });
});

describe("file naming", () => {
  it("slugifies prompts to safe ASCII", () => {
    assert.equal(slugify("Café crème: 50% OFF!! / ../../etc/passwd"), "cafe-creme-50-off-etc-passwd");
    assert.equal(slugify("   "), "");
    assert.ok(slugify("a".repeat(100)).length <= 40);
  });

  it("builds <job id>-<slug><ext> and never a path", () => {
    assert.equal(downloadFileName("job_1", "Hello World", ".png"), "job_1-hello-world.png");
    assert.equal(downloadFileName("job_1", "", ".mp4"), "job_1.mp4");
    assert.equal(downloadFileName("../x", "y", ".png"), "___x-y.png");
  });
});
