// Overlays: adsoptimiser_add_overlays (timed text cues and auto captions on a
// finished video), its local checks, video_path uploads, error messages and
// the older-server fallback; overlay jobs in get_job and list_jobs; and the
// add_captions node's timing and cues params in the pipeline catalogue.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROUTES, overlayRequestProblems } from "../src/server.mjs";
import { GRAPH_RULES, compactNodeType, describeNodeType } from "../src/pipeline.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const MP4 = Buffer.from("\x00\x00\x00\x18ftypmp42 fake mp4 bytes", "latin1");
const UPLOADED = "https://api.example.test/media/sources%2Fclip_1.mp4";

const CUES = [
  { text: "  Maths: A  ", start: 2, end: 4.5, style: "card", position: "center" },
  { text: "Science: B+", start: 5, end: 7.5, style: "card" },
];
const SENT_CUES = [
  { text: "Maths: A", start: 2, end: 4.5, style: "card", position: "center" },
  { text: "Science: B+", start: 5, end: 7.5, style: "card" },
];

const OVERLAY_JOB = {
  job_id: "job_ov",
  asset_type: "video",
  status: "ready",
  model: "media-overlays",
  prompt: "Overlays on job_clip",
  storage_uri: "videos/job_ov.mp4",
  generation_params: {
    source_job_id: "job_clip",
    cues: SENT_CUES,
    auto_captions: true,
    transcript: { text: "Maths, an A. Science, a B plus.", words_count: 7, model: "whisper-1", cost_usd: 0.0008 },
    character_id: "chr_amos",
  },
};

/** GET /api/v1/pipelines/nodes as a current deployment sends add_captions (params as an array). */
const ADD_CAPTIONS_NODE = {
  type: "add_captions",
  label: "Add captions",
  inputs: [
    { name: "video", kind: "video", required: true, maxConnections: 1 },
    { name: "text", kind: "text", maxConnections: 1 },
  ],
  outputs: [{ name: "video", kind: "video" }],
  constraints: ["Burns captions in."],
  enums: { position: ["bottom", "center", "top"], timing: ["even", "speech"] },
  params: [
    { name: "captions", type: "string", maxLength: 2000, description: "The words to show." },
    { name: "position", type: "string", enum: ["bottom", "center", "top"], default: "bottom" },
    { name: "timing", type: "string", enum: ["even", "speech"], description: "speech times captions to the words." },
    {
      name: "cues",
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          position: { enum: ["top", "center", "bottom"] },
          style: { enum: ["caption", "card"] },
        },
        required: ["text", "start", "end"],
      },
      description: "Timed text cues.",
    },
  ],
};

function makeApi(state) {
  return (r) => {
    const route = `${r.method} ${r.path}`;
    if (route === "POST /api/v1/jobs/source-media") {
      return { json: { source_url: UPLOADED, key: "sources/clip_1.mp4", bytes: MP4.length } };
    }
    if (route === "POST /api/v1/jobs/overlays") {
      if (state.overlaysError) return state.overlaysError;
      const body = JSON.parse(r.body.toString());
      return {
        status: 201,
        json: {
          job_id: "job_ov",
          asset_type: "video",
          status: "queued",
          model: "media-overlays",
          prompt: "Overlays",
          generation_params: {
            source_job_id: body.video_job_id ?? null,
            cues: body.cues ?? [],
            auto_captions: body.auto_captions === true,
          },
        },
      };
    }
    if (route === "GET /api/v1/jobs/job_ov") return { json: OVERLAY_JOB };
    if (route === "GET /api/v1/jobs/job_clip") {
      return { json: { job_id: "job_clip", asset_type: "video", status: "ready", storage_uri: "videos/clip.mp4" } };
    }
    if (route === "GET /api/v1/jobs") {
      return {
        json: {
          jobs: [
            { ...OVERLAY_JOB, status: "generating", storage_uri: null },
            { job_id: "job_clip", asset_type: "video", status: "ready", storage_uri: "videos/clip.mp4", prompt: "A clip" },
          ],
          total: 2,
        },
      };
    }
    if (route === "GET /api/v1/pipelines/nodes") return { json: { max_nodes: 12, nodes: [ADD_CAPTIONS_NODE] } };
    return undefined;
  };
}

function routeOf(r) {
  const path = r.path.replace(/^\/api\/v1\/jobs\/(?!enhance-prompt$|source-media$|lip-sync$|overlays$)[^/]+$/, "/api/v1/jobs/:id");
  return `${r.method} ${path}`;
}

describe("overlays", () => {
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
    work = tempDir("adsopt-ov-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    work.cleanup();
    stub.requests.length = 0;
  });

  const overlayBodies = () =>
    stub.requests
      .filter((r) => r.method === "POST" && r.path === "/api/v1/jobs/overlays")
      .map((r) => JSON.parse(r.body.toString()));
  const clip = (name = "clip.mp4", bytes = MP4) => {
    const file = join(work.dir, name);
    writeFileSync(file, bytes);
    return file;
  };

  describe("sources and request body", () => {
    const cases = [
      ["video_job_id", () => ({ video_job_id: "job_clip" }), { video_job_id: "job_clip" }],
      ["video_url", () => ({ video_url: "https://cdn.example.com/clip.mp4" }), { video_url: "https://cdn.example.com/clip.mp4" }],
      ["video_path", (file) => ({ video_path: file }), { video_url: UPLOADED }],
    ];
    for (const [label, source, expected] of cases) {
      it(`${label}: calls only its documented routes with the bearer token, and sends the contract's body`, async () => {
        const res = await ctx.call("adsoptimiser_add_overlays", {
          ...source(clip()),
          cues: CUES,
          auto_captions: true,
          captions_position: "top",
          script: "  Maths, an A. Science, a B plus.  ",
        });
        assert.equal(res.isError, false, res.text);
        for (const r of stub.requests) {
          assert.ok(TOOL_ROUTES.adsoptimiser_add_overlays.includes(routeOf(r)), `add_overlays called ${routeOf(r)}`);
          assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
        }
        assert.deepEqual(overlayBodies(), [
          {
            ...expected,
            cues: SENT_CUES,
            auto_captions: true,
            captions_position: "top",
            script: "Maths, an A. Science, a B plus.",
          },
        ]);
        assert.equal(res.structured.job_id, "job_ov");
        assert.equal(res.structured.model, "media-overlays");
        assert.equal(res.structured.overlays.cue_count, 2);
        assert.equal(res.structured.overlays.auto_captions, true);
        assert.match(res.text, /Job job_ov: overlay video queued \(Text overlays\)/);
        assert.match(res.text, /Overlays started: 2 timed cues and auto captions \(transcription about US\$0\.006 per minute of video\)/);
        assert.match(res.text, /one creative job from the plan allowance, not a generation/);
        assert.match(res.text, /adsoptimiser_get_job/);
        assert.ok(!res.text.includes(TOKEN));
      });
    }

    it("video_job_id is sent as is, with no other call", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", { video_job_id: "job_clip", cues: [CUES[1]] });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(
        stub.requests.map((r) => `${r.method} ${r.path}`),
        ["POST /api/v1/jobs/overlays"]
      );
      assert.deepEqual(overlayBodies(), [{ video_job_id: "job_clip", cues: [SENT_CUES[1]] }]);
      assert.match(res.text, /Overlays started: 1 timed cue\./);
    });

    it("auto captions alone send no cues", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", { video_url: "https://cdn.example.com/c.mp4", auto_captions: true });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(overlayBodies(), [{ video_url: "https://cdn.example.com/c.mp4", auto_captions: true }]);
      assert.match(res.text, /Overlays started: auto captions/);
    });

    it("cues with auto_captions false send auto_captions false", async () => {
      await ctx.call("adsoptimiser_add_overlays", { video_url: "https://cdn.example.com/c.mp4", cues: [CUES[1]], auto_captions: false });
      assert.deepEqual(overlayBodies(), [{ video_url: "https://cdn.example.com/c.mp4", cues: [SENT_CUES[1]], auto_captions: false }]);
    });

    it("video_path uploads the clip as source_type video and sends its hosted URL", async () => {
      const file = clip("talk.mov");
      const res = await ctx.call("adsoptimiser_add_overlays", { video_path: file, auto_captions: true });
      assert.equal(res.isError, false, res.text);
      const uploads = stub.requests.filter((r) => r.path === "/api/v1/jobs/source-media");
      assert.equal(uploads.length, 1);
      const form = await stub.formData(uploads[0]);
      assert.equal(form.get("source_type"), "video");
      assert.equal(form.get("purpose"), null);
      assert.equal(form.get("file").name, "talk.mov");
      assert.equal(form.get("file").type, "video/quicktime");
      assert.deepEqual(overlayBodies(), [{ video_url: UPLOADED, auto_captions: true }]);
      assert.deepEqual(res.structured.upload, { path: file, video_url: UPLOADED });
      assert.match(res.text, /Uploaded .*talk\.mov as the source video/);
    });

    it("video_path is refused locally when missing or not a video", async () => {
      const image = join(work.dir, "still.png");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
      const cases = [
        [join(work.dir, "missing.mp4"), /File not found/],
        [image, /still\.png is an image, but a video is needed here/],
        [clip("clip.avi"), /unsupported file type/],
      ];
      for (const [path, pattern] of cases) {
        const res = await ctx.call("adsoptimiser_add_overlays", { video_path: path, auto_captions: true });
        assert.equal(res.isError, true, path);
        assert.match(res.text, pattern);
      }
      assert.equal(stub.requests.length, 0);
    });
  });

  describe("local checks", () => {
    const url = "https://cdn.example.com/c.mp4";
    const cue = { text: "Hi", start: 0, end: 1 };
    const invalid = [
      ["no source", { cues: [cue] }, /exactly one of video_job_id, video_url or video_path/],
      ["two sources", { video_job_id: "job_clip", video_url: url, cues: [cue] }, /not video_job_id and video_url/],
      ["all three sources", { video_job_id: "job_clip", video_url: url, video_path: "/x.mp4", cues: [cue] }, /exactly one/],
      ["neither cues nor auto_captions", { video_url: url }, /at least one cue in cues, or set auto_captions to true/],
      ["empty cues", { video_url: url, cues: [] }, /at least one cue/],
      ["empty cues with auto_captions false", { video_url: url, cues: [], auto_captions: false }, /at least one cue/],
      ["51 cues", { video_url: url, cues: Array.from({ length: 51 }, () => cue) }, /At most 50 cues in one request \(got 51\)/],
      ["an empty cue text", { video_url: url, cues: [{ ...cue, text: "   " }] }, /cues\[0\]\.text is empty/],
      ["a cue text over 200 characters", { video_url: url, cues: [{ ...cue, text: "a".repeat(201) }] }, /cues\[0\]\.text is 201 characters; at most 200/],
      ["a negative start", { video_url: url, cues: [{ ...cue, start: -1 }] }, /cues\[0\]\.start is -1; it must be 0 or more/],
      ["end equal to start", { video_url: url, cues: [{ ...cue, start: 2, end: 2 }] }, /cues\[0\]\.end \(2\) must be after start \(2\)/],
      ["end before start", { video_url: url, cues: [cue, { ...cue, start: 5, end: 3 }] }, /cues\[1\]\.end \(3\) must be after start \(5\)/],
      ["an unknown position", { video_url: url, cues: [{ ...cue, position: "middle" }] }, /cues\[0\]\.position must be top, center, bottom, not "middle"/],
      ["an unknown style", { video_url: url, cues: [{ ...cue, style: "banner" }] }, /cues\[0\]\.style must be caption or card, not "banner"/],
      ["an unknown captions_position", { video_url: url, auto_captions: true, captions_position: "left" }, /captions_position must be top, center, bottom, not "left"/],
    ];
    for (const [label, args, pattern] of invalid) {
      it(`refuses ${label} before anything is sent`, async () => {
        const res = await ctx.call("adsoptimiser_add_overlays", args);
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.match(res.text, /Nothing was sent or charged\./);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("lists every problem at once", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", {
        cues: [{ text: "", start: -1, end: -2, style: "banner" }],
        captions_position: "left",
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /^Not sent: 6 problems with the overlays request\./);
      assert.equal(res.structured.problems.length, 6);
      assert.equal(stub.requests.length, 0);
    });

    it("rejects a malformed source before calling the API", async () => {
      for (const args of [{ video_url: "http://cdn.example.com/c.mp4" }, { video_job_id: "../x" }]) {
        const res = await ctx.call("adsoptimiser_add_overlays", { ...args, auto_captions: true });
        assert.equal(res.isError, true);
      }
      assert.equal(stub.requests.length, 0);
    });

    it("overlayRequestProblems accepts the contract's valid shapes", () => {
      assert.deepEqual(overlayRequestProblems({ video_url: "https://x.test/a.mp4", auto_captions: true }), []);
      assert.deepEqual(
        overlayRequestProblems({
          video_job_id: "job_1",
          cues: [
            { text: "a".repeat(200), start: 0, end: 0.1, position: "top", style: "caption" },
            ...Array.from({ length: 49 }, (_, i) => ({ text: "x", start: i, end: i + 1, position: "bottom", style: "card" })),
          ],
          captions_position: "center",
        }),
        []
      );
    });

    it("describes the example, auto captions and script in the tool description", async () => {
      const { tools } = await ctx.client.listTools();
      const tool = tools.find((t) => t.name === "adsoptimiser_add_overlays");
      assert.match(tool.description, /grade cards timed to spoken moments/);
      assert.match(tool.description, /"style": "card"/);
      assert.match(tool.description, /Use auto_captions when the video has speech/);
      assert.match(tool.description, /whisper-1, about US\$0\.006 per minute/);
      assert.match(tool.description, /Pass script when you know the words.*corrects the transcript's spellings/);
      assert.match(tool.description, /follow it with adsoptimiser_get_job/);
      assert.match(tool.description, /before anything is sent or charged/);
      assert.equal(tool.inputSchema.required, undefined, "add_overlays takes one of several sources");
      for (const field of ["video_job_id", "video_url", "video_path", "cues", "auto_captions", "captions_position", "script"]) {
        assert.ok(tool.inputSchema.properties[field], `add_overlays takes ${field}`);
      }
      assert.ok(!/—/.test(JSON.stringify(tool)), "no em dashes");
    });
  });

  describe("errors", () => {
    const url = { video_url: "https://cdn.example.com/c.mp4", cues: [{ text: "Hi", start: 0, end: 1 }] };
    const cases = [
      [400, "invalid_cues", "Invalid cues", { errors: ["cues[0].end is past the end of the video (9.5s)", { path: "cues[1]", message: "overlaps cues[0]" }] }, /The cues were refused: Invalid cues\.\n- cues\[0\]\.end is past the end of the video \(9\.5s\)\n- cues\[1\]: overlaps cues\[0\]\nFix them and try again\. Nothing was charged\./],
      [400, "invalid_request", "video_url must be https", {}, /The overlays request was refused: video_url must be https\.\nNothing was charged\./],
      [404, "not_found", "Source video job not found", {}, /Not found: Source video job not found\. Check video_job_id with adsoptimiser_list_jobs/],
      [409, "source_not_ready", "The source video job is not ready yet", {}, /isn't ready yet.*adsoptimiser_get_job shows it ready/],
      [415, "not_a_video", "The source job is an image", {}, /The source isn't a video \(The source job is an image\)/],
      [503, "transcription_not_configured", "Transcription is not configured", {}, /Auto captions aren't available on this Ads Optimiser deployment.*Nothing was charged\. Pass timed cues instead/],
      [502, "transcription_failed", "Whisper returned 500", {}, /speech could not be transcribed \(Whisper returned 500\)\. No job was created/],
      [403, "token_scope_denied", "API tokens cannot use this route", {}, /doesn't support overlays yet/],
    ];
    for (const [status, code, message, extra, pattern] of cases) {
      it(`maps ${status} ${code}`, async () => {
        state.overlaysError = { status, json: { error: message, code, ...extra } };
        const res = await ctx.call("adsoptimiser_add_overlays", url);
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.equal(res.structured.status, status);
        assert.equal(res.structured.code, code);
      });
    }

    it("keeps the general plan limit and quota messages for 429", async () => {
      state.overlaysError = { status: 429, json: { error: "Monthly creative job limit reached.", code: "plan_limit_exceeded" } };
      let res = await ctx.call("adsoptimiser_add_overlays", url);
      assert.equal(res.isError, true);
      assert.match(res.text, /Plan limit reached.*https:\/\/app\.example\.test\/#\/billing/);
      state.overlaysError = { status: 429, json: { error: "Rate limit", code: "rate_limited", retry_after_seconds: 30 } };
      res = await ctx.call("adsoptimiser_add_overlays", url);
      assert.match(res.text, /Try again in 30 seconds/);
    });

    it("an older server without the route (404) says overlays aren't supported yet", async () => {
      // The stub answers an unknown route with a bare 404, as an older deployment does.
      stub.setHandler((r) => (r.path === "/api/v1/jobs/overlays" ? undefined : makeApi(state)(r)));
      const res = await ctx.call("adsoptimiser_add_overlays", url);
      assert.equal(res.isError, true);
      assert.match(res.text, /this Ads Optimiser deployment doesn't support overlays yet/i);
      assert.match(res.text, /add_captions/);
      assert.deepEqual(stub.requests.map((r) => `${r.method} ${r.path}`), ["POST /api/v1/jobs/overlays"]);
    });

    it("a bare 404 with video_job_id checks the job: it exists, so the route is missing", async () => {
      stub.setHandler((r) => (r.path === "/api/v1/jobs/overlays" ? undefined : makeApi(state)(r)));
      const res = await ctx.call("adsoptimiser_add_overlays", { video_job_id: "job_clip", auto_captions: true });
      assert.match(res.text, /doesn't support overlays yet/);
      for (const r of stub.requests) {
        assert.ok(TOOL_ROUTES.adsoptimiser_add_overlays.includes(routeOf(r)), `add_overlays called ${routeOf(r)}`);
      }
      assert.deepEqual(stub.requests.map((r) => `${r.method} ${r.path}`), ["POST /api/v1/jobs/overlays", "GET /api/v1/jobs/job_clip"]);
    });

    it("a bare 404 with video_job_id checks the job: it is missing, so it is not found", async () => {
      stub.setHandler((r) => (r.path === "/api/v1/jobs/overlays" ? undefined : makeApi(state)(r)));
      const res = await ctx.call("adsoptimiser_add_overlays", { video_job_id: "job_gone", auto_captions: true });
      assert.equal(res.isError, true);
      assert.match(res.text, /Not found: Not found\. Check video_job_id/);
    });
  });

  describe("job summaries", () => {
    it("get_job describes an overlay job: cues, auto captions, transcript words and cost", async () => {
      const res = await ctx.call("adsoptimiser_get_job", { job_id: "job_ov", include_thumbnails: false });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /Job job_ov: overlay video ready \(Text overlays\)/);
      assert.match(
        res.text,
        /Overlays: 2 timed cues, auto captions from 7 transcribed words \(whisper-1, transcription US\$0\.0008\), source video job job_clip\. Rendering counts as one creative job \(not a generation\)\./
      );
      assert.match(res.text, /Transcript: Maths, an A\. Science, a B plus\./);
      assert.deepEqual(res.structured.overlays, {
        source_job_id: "job_clip",
        cue_count: 2,
        auto_captions: true,
        transcript_words: 7,
        transcript_text: "Maths, an A. Science, a B plus.",
        transcription_model: "whisper-1",
        transcription_cost_usd: 0.0008,
        character_id: "chr_amos",
      });
      assert.equal(res.structured.model_label, "Text overlays");
    });

    it("get_job describes cues-only overlay jobs without transcript lines", async () => {
      stub.setHandler((r) =>
        r.path === "/api/v1/jobs/job_ov"
          ? { json: { ...OVERLAY_JOB, generation_params: { source_job_id: "job_clip", cues: [SENT_CUES[0]], auto_captions: false } } }
          : undefined
      );
      const res = await ctx.call("adsoptimiser_get_job", { job_id: "job_ov", include_thumbnails: false });
      assert.match(res.text, /Overlays: 1 timed cue, source video job job_clip\./);
      assert.ok(!/Transcript:/.test(res.text));
    });

    it("list_jobs marks overlay jobs with their cues and captions", async () => {
      const res = await ctx.call("adsoptimiser_list_jobs", {});
      assert.match(res.text, /- job_ov overlay video generating "Overlays on job_clip" \[2 timed cues, auto captions from 7 transcribed words \(whisper-1, transcription US\$0\.0008\)\]/);
      assert.match(res.text, /- job_clip video ready/);
      assert.equal(res.structured.jobs[0].overlays.cue_count, 2);
      assert.equal(res.structured.jobs[1].overlays, undefined);
    });
  });

  describe("pipelines", () => {
    it("get_pipeline_nodes passes add_captions timing and cues through from the API", async () => {
      const res = await ctx.call("adsoptimiser_get_pipeline_nodes");
      assert.equal(res.isError, false, res.text);
      const node = res.structured.node_types.find((n) => n.type === "add_captions");
      assert.deepEqual(Object.keys(node.params), ["captions", "position", "timing", "cues"]);
      assert.deepEqual(node.params.timing.enum, ["even", "speech"]);
      assert.equal(node.params.timing.description, "speech times captions to the words.");
      assert.equal(node.params.cues.type, "array");
      assert.equal(node.params.cues.max_items, 50);
      assert.equal(node.params.cues.description, "Timed text cues.");
      assert.match(res.text, /timing \(even\|speech\)/);
      assert.match(res.text, /cues \(list of \{"text","start","end","position"\?,"style"\?\}, max 50 items\)/);
      assert.ok(res.structured.rules.some((r) => /add_captions timing: even .* speech transcribes/.test(r)));
      assert.ok(res.structured.rules.some((r) => /adsoptimiser_add_overlays/.test(r)));
    });

    it("the local fallback describes timing and cues when the API sends only enums", () => {
      const node = compactNodeType({ type: "add_captions", label: "Captions", enums: { position: ["bottom"] } });
      assert.deepEqual(Object.keys(node.params), ["captions", "position", "timing", "cues"]);
      assert.deepEqual(node.params.timing.enum, ["even", "speech"]);
      assert.match(node.params.timing.description, /whisper-1, about US\$0\.006 per minute/);
      assert.equal(node.params.cues.max_items, 50);
      assert.match(node.params.cues.description, /1 to 200 characters/);
      const text = describeNodeType(node);
      assert.match(text, /timing \(even\|speech\)/);
      assert.match(
        text,
        /cues \(list of \{"text","start","end","position"\?,"style"\?,"y"\?,"size"\?,"max_width"\?\}, max 50 items\)/
      );
      assert.ok(GRAPH_RULES.some((r) => /add_captions timing/.test(r) && /never a generation/.test(r)));
    });
  });
});
