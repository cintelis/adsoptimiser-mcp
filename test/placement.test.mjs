// 0.10.0: text placement on overlays (y, size, max_width, line breaks, and
// captions_y and captions_size for auto captions), the add_captions node's
// cues with the same fields, the input_video pipeline node ("Your video")
// with local video paths, the re-caption template in the listing, and the
// messages from older deployments that lack these.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROUTES, overlayRequestProblems } from "../src/server.mjs";
import {
  GRAPH_RULES,
  compactNodeType,
  cueForApi,
  describeNodeType,
  graphCueProblems,
  localVideoRefs,
  placementFeaturesUsed,
  refusedPlacementFeature,
  unsupportedGraphFeatures,
} from "../src/pipeline.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const MP4 = Buffer.from("\x00\x00\x00\x18ftypmp42 fake mp4 bytes", "latin1");
const UPLOADED = "https://api.example.test/media/sources%2Fclip_1.mp4";
const URL_SOURCE = { video_url: "https://cdn.example.com/c.mp4" };
const cue = { text: "Hi", start: 0, end: 1 };

const INPUT_VIDEO_NODE = {
  type: "input_video",
  label: "Your video (library)",
  inputs: [],
  outputs: [{ name: "video", kind: "video" }],
  constraints: ["Free; creates no job."],
  enums: {},
  params: [
    { name: "video_job_id", type: "string", description: "A ready video job." },
    { name: "video_url", type: "string", description: "The workspace's own /media URL." },
  ],
};
const ADD_CAPTIONS_NODE = {
  type: "add_captions",
  label: "Add captions",
  inputs: [
    { name: "video", kind: "video", required: true, maxConnections: 1 },
    { name: "text", kind: "text", maxConnections: 1 },
  ],
  outputs: [{ name: "video", kind: "video" }],
  constraints: [],
  enums: { position: ["bottom", "center", "top"], timing: ["even", "speech"] },
};

const TEMPLATES = [
  { id: "product-ad", name: "Product ad", description: "Image then video.", stages: ["generate_image", "image_to_video"] },
  {
    id: "video-recaption",
    name: "Re-caption a video (your video -> captions)",
    description: "Captions a video you already have.",
    stages: ["input_video", "add_captions"],
    needs_character: false,
  },
];

/** A current deployment (knows input_video and placement), or an older one. */
function makeApi(state) {
  return (r) => {
    const route = `${r.method} ${r.path}`;
    const json = () => JSON.parse(r.body.toString());
    if (route === "POST /api/v1/jobs/source-media") {
      state.uploads = (state.uploads ?? 0) + 1;
      return { json: { source_url: UPLOADED, key: "sources/clip_1.mp4", bytes: MP4.length } };
    }
    if (route === "POST /api/v1/jobs/overlays") {
      if (state.overlaysError) return state.overlaysError;
      return {
        status: 201,
        json: { job_id: "job_ov", asset_type: "video", status: "queued", model: "media-overlays", prompt: "Overlays", generation_params: {} },
      };
    }
    if (route === "GET /api/v1/pipelines/templates") return { json: { templates: TEMPLATES } };
    if (route === "GET /api/v1/pipelines/graphs") return { json: { graphs: [] } };
    if (route === "GET /api/v1/pipelines/nodes") return { json: { max_nodes: 12, nodes: [INPUT_VIDEO_NODE, ADD_CAPTIONS_NODE] } };
    const graphErrors = (graph) =>
      state.older ? graph.nodes.filter((n) => n.type === "input_video").map((n) => `Unknown node type "input_video" on node "${n.id}"`) : [];
    if (route === "POST /api/v1/pipelines/graphs/validate") {
      const errors = state.validateErrors ?? graphErrors(json().graph);
      return { json: { ok: errors.length === 0, errors, estimated_cost_usd: errors.length ? null : 0.01 } };
    }
    if (route === "POST /api/v1/pipelines/graphs") {
      const body = json();
      const errors = state.validateErrors ?? graphErrors(body.graph);
      if (errors.length) return { status: 400, json: { error: "Invalid graph", errors } };
      return { status: 201, json: { graph_id: "pg_new", name: body.name } };
    }
    if (route === "POST /api/v1/pipelines") {
      return { json: { run: { run_id: "run_1", status: "running" }, stages: [{ stage_type: "input_video" }, { stage_type: "add_captions" }], estimated_cost_usd: 0.01 } };
    }
    return undefined;
  };
}

describe("placement and input_video (0.10.0)", () => {
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
    work = tempDir("adsopt-place-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    work.cleanup();
    stub.requests.length = 0;
  });

  const posts = (path) => stub.requests.filter((r) => r.method === "POST" && r.path === path);
  const bodyOf = (r) => JSON.parse(r.body.toString());
  const clip = (name = "clip.mp4") => {
    const file = join(work.dir, name);
    writeFileSync(file, MP4);
    return file;
  };

  describe("overlay placement: local checks", () => {
    const invalid = [
      ["y below 0.05", { cues: [{ ...cue, y: 0.04 }] }, /cues\[0\]\.y must be a number from 0\.05 to 0\.95 .*not 0\.04/],
      ["y above 0.95", { cues: [{ ...cue, y: 0.96 }] }, /cues\[0\]\.y must be a number from 0\.05 to 0\.95/],
      ["y of 0 (the top edge)", { cues: [{ ...cue, y: 0 }] }, /cues\[0\]\.y must be/],
      ["y of 1", { cues: [{ ...cue, y: 1 }] }, /cues\[0\]\.y must be/],
      ["an unknown size", { cues: [{ ...cue, size: "huge" }] }, /cues\[0\]\.size must be small, medium, large, not "huge"/],
      ["max_width below 0.4", { cues: [{ ...cue, max_width: 0.39 }] }, /cues\[0\]\.max_width must be a number from 0\.4 to 1 .*not 0\.39/],
      ["max_width above 1", { cues: [{ ...cue, max_width: 1.01 }] }, /cues\[0\]\.max_width must be a number from 0\.4 to 1/],
      ["four lines of text", { cues: [{ ...cue, text: "a\nb\nc\nd" }] }, /cues\[0\]\.text has 4 lines; at most 3/],
      ["four lines with Windows line endings", { cues: [{ ...cue, text: "a\r\nb\r\nc\r\nd" }] }, /cues\[0\]\.text has 4 lines/],
      ["captions_y below 0.05", { auto_captions: true, captions_y: 0.01 }, /captions_y must be a number from 0\.05 to 0\.95/],
      ["captions_y above 0.95", { auto_captions: true, captions_y: 0.99 }, /captions_y must be a number from 0\.05 to 0\.95/],
      ["an unknown captions_size", { auto_captions: true, captions_size: "xl" }, /captions_size must be small, medium, large, not "xl"/],
    ];
    for (const [label, args, pattern] of invalid) {
      it(`refuses ${label} before anything is sent`, async () => {
        const res = await ctx.call("adsoptimiser_add_overlays", { ...URL_SOURCE, ...args });
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.match(res.text, /Nothing was sent or charged\./);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("accepts the boundaries of every range, three lines and each size", () => {
      const cues = [
        { ...cue, y: 0.05, max_width: 0.4, size: "small" },
        { ...cue, y: 0.95, max_width: 1.0, size: "medium" },
        { ...cue, y: 0.62, size: "large", text: "one\ntwo\nthree" },
        { ...cue, text: "a".repeat(200) },
      ];
      assert.deepEqual(overlayRequestProblems({ ...URL_SOURCE, cues }), []);
      for (const captions_size of ["small", "medium", "large"]) {
        assert.deepEqual(
          overlayRequestProblems({ ...URL_SOURCE, auto_captions: true, captions_y: 0.05, captions_size }),
          []
        );
      }
      assert.deepEqual(overlayRequestProblems({ ...URL_SOURCE, auto_captions: true, captions_y: 0.95 }), []);
    });

    it("lists placement problems together with the others", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", {
        ...URL_SOURCE,
        cues: [{ text: "a\nb\nc\nd", start: 2, end: 1, y: 2, size: "xl", max_width: 0.1 }],
        auto_captions: true,
        captions_y: -1,
        captions_size: "tiny",
      });
      assert.equal(res.isError, true);
      assert.equal(res.structured.problems.length, 7, res.text);
      assert.match(res.text, /^Not sent: 7 problems/);
      assert.equal(stub.requests.length, 0);
    });

    it("zod refuses a y that is not a number before anything is sent", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", { ...URL_SOURCE, cues: [{ ...cue, y: "0.6" }] });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  });

  describe("overlay placement: request body", () => {
    it("sends y, size, max_width, captions_y and captions_size as given", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", {
        ...URL_SOURCE,
        cues: [
          { text: "Maths: A", start: 2, end: 4.5, style: "card", y: 0.62, size: "large", max_width: 0.8 },
          { text: "Science: B+", start: 5, end: 7.5, style: "caption", position: "top", y: 0.7, size: "small" },
        ],
        auto_captions: true,
        captions_y: 0.85,
        captions_size: "medium",
      });
      assert.equal(res.isError, false, res.text);
      for (const r of stub.requests) {
        assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
        assert.ok(TOOL_ROUTES.adsoptimiser_add_overlays.includes(`${r.method} ${r.path}`));
      }
      assert.deepEqual(bodyOf(posts("/api/v1/jobs/overlays")[0]), {
        ...URL_SOURCE,
        cues: [
          { text: "Maths: A", start: 2, end: 4.5, style: "card", y: 0.62, size: "large", max_width: 0.8 },
          { text: "Science: B+", start: 5, end: 7.5, position: "top", style: "caption", y: 0.7, size: "small" },
        ],
        auto_captions: true,
        captions_y: 0.85,
        captions_size: "medium",
      });
    });

    it("keeps line breaks, as \\n, with each line trimmed", async () => {
      const res = await ctx.call("adsoptimiser_add_overlays", {
        ...URL_SOURCE,
        cues: [
          { text: "  Science \r\n  B+  ", start: 0, end: 2, style: "card" },
          { text: "one\ntwo\nthree", start: 2, end: 4 },
        ],
      });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(bodyOf(posts("/api/v1/jobs/overlays")[0]).cues, [
        { text: "Science\nB+", start: 0, end: 2, style: "card" },
        { text: "one\ntwo\nthree", start: 2, end: 4 },
      ]);
    });

    it("leaves out placement fields that were not given", async () => {
      await ctx.call("adsoptimiser_add_overlays", { ...URL_SOURCE, cues: [cue], auto_captions: true });
      const body = bodyOf(posts("/api/v1/jobs/overlays")[0]);
      assert.deepEqual(body, { ...URL_SOURCE, cues: [cue], auto_captions: true });
    });

    it("cueForApi keeps only the contract's fields", () => {
      assert.deepEqual(cueForApi({ text: " x ", start: 0, end: 1, y: 0.5, colour: "red" }), { text: "x", start: 0, end: 1, y: 0.5 });
    });
  });

  describe("overlay tool description", () => {
    it("advises face-safe placement, line breaks, and that any finished video works", async () => {
      const { tools } = await ctx.client.listTools();
      const tool = tools.find((t) => t.name === "adsoptimiser_add_overlays");
      assert.match(tool.description, /ANY finished video/);
      assert.match(tool.description, /no need to regenerate the video or run a pipeline/);
      assert.match(tool.description, /keep cards out of the upper third, where the face is: use y 0\.62 or position "center"/);
      assert.match(tool.description, /For two short lines, put \\n in the text \(at most 3 lines\)/);
      assert.match(tool.description, /"y": 0\.62/);
      assert.match(tool.description, /captions_y/);
      for (const field of ["captions_y", "captions_size"]) {
        assert.ok(tool.inputSchema.properties[field], `add_overlays takes ${field}`);
      }
      const cueProps = tool.inputSchema.properties.cues.items.properties;
      for (const field of ["y", "size", "max_width"]) assert.ok(cueProps[field], `a cue takes ${field}`);
      assert.ok(!/—/.test(JSON.stringify(tool)), "no em dashes");
    });

    it("the server instructions say add_overlays works on any existing video", async () => {
      const instructions = ctx.client.getInstructions() ?? "";
      assert.match(instructions, /adsoptimiser_add_overlays: it works on any existing video, with no need to regenerate it or run a pipeline/);
    });
  });

  describe("older deployments refusing placement", () => {
    const cases = [
      [
        "cue fields (invalid_cues listing an unknown field)",
        { cues: [{ ...cue, y: 0.62, size: "large" }] },
        { status: 400, json: { error: "Invalid cues", code: "invalid_cues", errors: ['cues[0]: unknown field "y"', 'cues[0]: unknown field "size"'] } },
        /this Ads Optimiser deployment doesn't support cue placement \(y, size and max_width\) yet/i,
      ],
      [
        "max_width named in the message",
        { cues: [{ ...cue, max_width: 0.8 }] },
        { status: 400, json: { error: "Unrecognized key(s) in object: 'max_width'", code: "invalid_cues" } },
        /doesn't support cue placement/,
      ],
      [
        "caption fields (invalid_request)",
        { auto_captions: true, captions_y: 0.8, captions_size: "large" },
        { status: 400, json: { error: "Unexpected field captions_y", code: "invalid_request" } },
        /doesn't support caption placement \(captions_y and captions_size\) yet/,
      ],
      [
        "line breaks",
        { cues: [{ ...cue, text: "Two\nlines" }] },
        { status: 400, json: { error: "Invalid cues", code: "invalid_cues", errors: ["cues[0].text must not contain line breaks"] } },
        /doesn't support line breaks in cues yet/,
      ],
    ];
    for (const [label, args, reply, pattern] of cases) {
      it(`says the deployment doesn't support ${label}`, async () => {
        state.overlaysError = reply;
        const res = await ctx.call("adsoptimiser_add_overlays", { ...URL_SOURCE, ...args });
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.match(res.text, /Nothing was charged/);
        assert.equal(res.structured.status, 400);
      });
    }

    it("keeps the usual invalid_cues message when the refusal is about something else", async () => {
      state.overlaysError = {
        status: 400,
        json: { error: "Invalid cues", code: "invalid_cues", errors: ["cues[0].end is past the end of the video (9.5s)"] },
      };
      const res = await ctx.call("adsoptimiser_add_overlays", { ...URL_SOURCE, cues: [{ ...cue, y: 0.62 }] });
      assert.match(res.text, /The cues were refused: Invalid cues\.\n- cues\[0\]\.end is past the end/);
      assert.doesNotMatch(res.text, /doesn't support/);
    });

    it("does not blame a field the request did not use", () => {
      assert.equal(refusedPlacementFeature('unknown field "y"', new Set(["captions_y"])), null);
      assert.equal(refusedPlacementFeature("cues[0].end must be after start", placementFeaturesUsed([{ y: 0.5 }])), null);
      assert.equal(
        refusedPlacementFeature('unknown field "size"', placementFeaturesUsed([{ size: "large" }])),
        "cue placement (y, size and max_width)"
      );
    });
  });

  describe("input_video in pipelines", () => {
    const recaption = (params, cues) => ({
      nodes: [
        { id: "src", type: "input_video", params },
        { id: "cap", type: "add_captions", params: { timing: "speech", ...(cues ? { cues } : {}) } },
      ],
      edges: [{ from: { node: "src", output: "video" }, to: { node: "cap", input: "video" } }],
    });

    it("uploads a local video_path as source_type video and substitutes the hosted URL", async () => {
      const file = clip("talk.mov");
      const res = await ctx.call("adsoptimiser_validate_pipeline", { graph: recaption({ video_path: file }) });
      assert.equal(res.isError, false, res.text);
      const uploads = posts("/api/v1/jobs/source-media");
      assert.equal(uploads.length, 1);
      const form = await stub.formData(uploads[0]);
      assert.equal(form.get("source_type"), "video");
      assert.equal(form.get("file").name, "talk.mov");
      assert.equal(form.get("file").type, "video/quicktime");
      const sent = bodyOf(posts("/api/v1/pipelines/graphs/validate")[0]).graph;
      assert.deepEqual(sent.nodes[0].params, { video_url: UPLOADED });
      assert.deepEqual(res.structured.uploads, [{ node_id: "src", path: file, video_url: UPLOADED }]);
      assert.equal(res.structured.graph.nodes[0].params.video_url, UPLOADED);
      assert.match(res.text, /Uploaded 1 local video for input_video nodes \(src\)/);
    });

    it("treats a non-URL video_url as a local path, and reuses the upload when running", async () => {
      const file = clip();
      const run = await ctx.call("adsoptimiser_run_pipeline", { graph: recaption({ video_url: file }) });
      assert.equal(run.isError, false, run.text);
      await ctx.call("adsoptimiser_save_pipeline", { name: "Recaption", graph: recaption({ video_url: file }) });
      assert.equal(posts("/api/v1/jobs/source-media").length, 1, "the same file is uploaded once");
      assert.equal(bodyOf(posts("/api/v1/pipelines")[0]).graph.nodes[0].params.video_url, UPLOADED);
      assert.deepEqual(bodyOf(posts("/api/v1/pipelines/graphs")[0]).graph.nodes[0].params, { video_url: UPLOADED });
      assert.match(run.text, /Uploaded 1 local video for input_video nodes \(src\)/);
    });

    it("leaves video_job_id and https URLs alone", async () => {
      for (const params of [{ video_job_id: "job_clip" }, { video_url: "https://api.example.test/media/videos%2Fclip.mp4" }]) {
        const res = await ctx.call("adsoptimiser_validate_pipeline", { graph: recaption(params) });
        assert.equal(res.isError, false, res.text);
        assert.deepEqual(bodyOf(posts("/api/v1/pipelines/graphs/validate").at(-1)).graph.nodes[0].params, params);
      }
      assert.equal(posts("/api/v1/jobs/source-media").length, 0);
    });

    it("refuses conflicts, missing files and non-videos before anything is sent", async () => {
      const file = clip();
      const image = join(work.dir, "still.png");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
      const cases = [
        [{ video_path: file, video_url: "https://x.test/a.mp4" }, /input_video node "src" has both video_url and video_path/],
        [{ video_path: file, video_job_id: "job_clip" }, /has both video_job_id and video_path/],
        [{ video_url: file, video_job_id: "job_clip" }, /has both video_job_id and a local video_url/],
        [{ video_path: join(work.dir, "missing.mp4") }, /File not found/],
        [{ video_path: image }, /still\.png is an image, but a video is needed here/],
      ];
      for (const [params, pattern] of cases) {
        const res = await ctx.call("adsoptimiser_run_pipeline", { graph: recaption(params) });
        assert.equal(res.isError, true, JSON.stringify(params));
        assert.match(res.text, pattern);
      }
      assert.equal(stub.requests.length, 0);
    });

    it("passes add_captions cues with placement through, and checks them locally first", async () => {
      const cues = [{ text: "Maths\nA", start: 1, end: 3, style: "card", y: 0.62, size: "large", max_width: 0.7 }];
      const ok = await ctx.call("adsoptimiser_validate_pipeline", { graph: recaption({ video_job_id: "job_clip" }, cues) });
      assert.equal(ok.isError, false, ok.text);
      assert.deepEqual(bodyOf(posts("/api/v1/pipelines/graphs/validate")[0]).graph.nodes[1].params.cues, cues);

      stub.requests.length = 0;
      const bad = await ctx.call("adsoptimiser_save_pipeline", {
        name: "x",
        graph: recaption({ video_path: clip() }, [{ text: "a\nb\nc\nd", start: 0, end: 1, y: 0.01 }]),
      });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /Not sent: 2 problems with the add_captions cues/);
      assert.match(bad.text, /node "cap" cues\[0\]\.text has 4 lines/);
      assert.match(bad.text, /node "cap" cues\[0\]\.y must be a number from 0\.05 to 0\.95/);
      assert.match(bad.text, /Nothing was sent or charged/);
      assert.equal(stub.requests.length, 0, "nothing uploaded or sent");
    });

    it("an older deployment's unknown input_video node is named clearly", async () => {
      state.older = true;
      const graph = recaption({ video_job_id: "job_clip" });
      const validated = await ctx.call("adsoptimiser_validate_pipeline", { graph });
      assert.equal(validated.isError, true);
      assert.match(validated.text, /^This Ads Optimiser deployment doesn't support the input_video node \("Your video"\) yet\. To caption or re-caption a finished video, use adsoptimiser_add_overlays instead\./);
      assert.deepEqual(validated.structured.unsupported, ['the input_video node ("Your video")']);

      const run = await ctx.call("adsoptimiser_run_pipeline", { graph });
      assert.match(run.text, /doesn't support the input_video node/);

      const saved = await ctx.call("adsoptimiser_save_pipeline", { name: "x", graph });
      assert.equal(saved.isError, true);
      assert.match(saved.text, /doesn't support the input_video node/);
      assert.match(saved.text, /The pipeline graph was rejected/);
    });

    it("an older deployment refusing add_captions cue placement is named clearly", async () => {
      state.validateErrors = ['node "cap": cues[0] has unknown field "y"'];
      const res = await ctx.call("adsoptimiser_validate_pipeline", {
        graph: recaption({ video_job_id: "job_clip" }, [{ ...cue, y: 0.62 }]),
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /doesn't support cue placement \(y, size and max_width\) yet/);
    });

    it("list_pipelines marks templates that start from your video", async () => {
      const res = await ctx.call("adsoptimiser_list_pipelines");
      assert.equal(res.isError, false, res.text);
      const recap = res.structured.templates.find((t) => t.template_id === "video-recaption");
      assert.equal(recap.needs_video, true);
      assert.equal(recap.name, "Re-caption a video (your video -> captions)");
      assert.equal(res.structured.templates.find((t) => t.template_id === "product-ad").needs_video, false);
      assert.match(res.text, /- video-recaption: Re-caption a video \(your video -> captions\)\. .*starts from your video: run it as a graph with an input_video step/);
      assert.match(res.text, /adsoptimiser_add_overlays is simpler/);
    });

    it("the catalogue passes input_video through, with the local path note", async () => {
      const res = await ctx.call("adsoptimiser_get_pipeline_nodes");
      const node = res.structured.node_types.find((n) => n.type === "input_video");
      assert.equal(node.label, "Your video (library)");
      assert.deepEqual(node.inputs, []);
      assert.deepEqual(node.outputs, [{ name: "video", kind: "video" }]);
      assert.deepEqual(Object.keys(node.params), ["video_job_id", "video_url"]);
      assert.match(node.params.video_url.description, /^The workspace's own \/media URL\. .*local \.mp4 or \.mov path/);
      assert.match(res.text, /- input_video \(Your video \(library\)\)\. Inputs: none\. Outputs: video:video\./);
    });
  });
});

describe("placement and input_video helpers", () => {
  it("the local fallback describes input_video when the API sends no params", () => {
    const node = compactNodeType({ type: "input_video", label: "Your video (library)", outputs: [{ name: "video", kind: "video" }] });
    assert.deepEqual(Object.keys(node.params), ["video_job_id", "video_url"]);
    assert.match(node.params.video_job_id.description, /ready\) video job/);
    assert.match(node.params.video_url.description, /\/media URL.*local \.mp4 or \.mov/);
    assert.match(describeNodeType(node), /video_job_id; video_url/);
  });

  it("the graph rules cover input_video, the re-caption template and placement", () => {
    const rules = GRAPH_RULES.join("\n");
    assert.match(rules, /input_video \("Your video \(library\)"\).*free and creates no job/);
    assert.match(rules, /add_captions, add_voiceover, strip_audio, lip_sync or extend_video/);
    assert.match(rules, /Re-caption a video \(your video -> captions\)/);
    assert.match(rules, /text, input_image, input_video, character and refine_prompt are free/);
    assert.match(rules, /"y"\?,"size"\?,"max_width"\?/);
    assert.match(rules, /keep cards out of the upper third, where the face is: y 0\.62 or position center/);
    assert.ok(!/—/.test(rules), "no em dashes");
  });

  it("localVideoRefs finds only local input_video files", () => {
    const refs = localVideoRefs({
      nodes: [
        { id: "a", type: "input_video", params: { video_url: "https://x.test/a.mp4" } },
        { id: "b", type: "input_video", params: { video_job_id: "job_1" } },
        { id: "c", type: "input_video", params: { video_url: "C:\\clips\\c.mp4" } },
        { id: "d", type: "input_video", params: { video_path: "/tmp/d.mov" } },
        { id: "e", type: "input_image", params: { video_path: "/tmp/e.mov" } },
      ],
    });
    assert.deepEqual(
      refs.map((r) => [r.node.id, r.path]),
      [
        ["c", "C:\\clips\\c.mp4"],
        ["d", "/tmp/d.mov"],
      ]
    );
  });

  it("graphCueProblems checks only add_captions cues", () => {
    assert.deepEqual(graphCueProblems({ nodes: [{ id: "t", type: "text", params: { cues: "x" } }] }), []);
    assert.deepEqual(graphCueProblems({ nodes: [{ id: "c", type: "add_captions", params: { cues: "x" } }] }), [
      'node "c" cues must be a list of { text, start, end, position?, style?, y?, size?, max_width? }.',
    ]);
  });

  it("unsupportedGraphFeatures ignores unrelated errors", () => {
    assert.deepEqual(unsupportedGraphFeatures([{ message: "Graph contains a cycle" }], { nodes: [] }), []);
  });
});
