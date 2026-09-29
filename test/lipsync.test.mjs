// Lip-sync: the connector's lip_sync tool, plus video_path (a local clip,
// checked and uploaded for you), its error messages, the lip_sync pipeline
// node and the character-lip-sync template.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { MAX_LIP_SYNC_VIDEO_BYTES, TOOL_ROUTES } from "../src/server.mjs";
import { GRAPH_RULES, compactNodeType, describeNodeType, graphNeedsRunPrompt } from "../src/pipeline.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const MP4 = Buffer.from("\x00\x00\x00\x18ftypmp42 fake mp4 bytes", "latin1");
const UPLOADED = "https://api.example.test/media/sources%2Fclip_1.mp4";

/** GET /api/v1/pipelines/nodes as the live API sends the lip_sync node (params as an array). */
const LIP_SYNC_NODE = {
  type: "lip_sync",
  label: "Lip-sync (character speaks your line)",
  inputs: [
    { name: "video", kind: "video", required: true, maxConnections: 1 },
    { name: "script", kind: "text", maxConnections: 1, description: "The words to speak, from a text or refine node." },
  ],
  outputs: [{ name: "video", kind: "video" }],
  constraints: ["kling-lipsync (default, about US$0.014 per 5s): the source clip must be 2-10 seconds at 720p or 1080p (480p is refused)."],
  enums: { model: ["kling-lipsync"], voice_id: ["eve", "leo"] },
  params: [
    { name: "script", type: "string", maxLength: 900, description: "The exact words the person says." },
    {
      name: "voice",
      type: "object",
      oneOf: [
        { provider: { const: "xai" }, voice_id: { enum: ["eve", "leo"] } },
        { provider: { const: "openai" }, voice: { enum: ["cedar"] }, instructions: { type: "string", optional: true } },
      ],
      description: "Voice profile the line is spoken in.",
    },
    { name: "voice_id", type: "string", enum: ["eve", "leo"], description: "xAI preset voice." },
    { name: "model", type: "string", enum: ["kling-lipsync"], default: "kling-lipsync", description: "Lip-sync model." },
  ],
};

const TEMPLATES = [
  { id: "product-ad", name: "Product ad", description: "d", stages: ["image"] },
  {
    id: "character-lip-sync",
    name: "Character talking clip (designed voice)",
    description: "Pick a saved character and type exactly what they should say.",
    stages: ["refine_prompt", "character", "generate_image", "image_to_video", "lip_sync", "add_captions"],
    needs_character: true,
  },
];

function makeApi(state) {
  return (r) => {
    const route = `${r.method} ${r.path}`;
    if (route === "POST /api/v1/jobs/source-media") {
      return { json: { source_url: UPLOADED, key: "sources/clip_1.mp4", bytes: MP4.length } };
    }
    if (route === "GET /api/v1/jobs/job_clip") {
      return { json: { job_id: "job_clip", asset_type: "video", status: "ready", storage_uri: "videos/clip.mp4" } };
    }
    if (route === "GET /api/v1/jobs/job_busy") {
      return { json: { job_id: "job_busy", asset_type: "video", status: "generating" } };
    }
    if (route === "GET /api/v1/jobs/job_lipsync") {
      return {
        json: {
          job_id: "job_lipsync",
          asset_type: "video",
          status: "ready",
          model: "kling-lipsync",
          storage_uri: "videos/job_lipsync.mp4",
          generation_params: {
            source_mode: "lip_sync",
            source_job_id: "job_clip",
            voice: { provider: "openai", voice: "cedar", instructions: "slow and warm" },
            voice_provider: "openai",
            voice_source: "character",
            audio_duration_seconds: 6.4,
          },
        },
      };
    }
    if (route === "POST /api/v1/jobs/lip-sync") {
      if (state.lipSyncError) return state.lipSyncError;
      const body = JSON.parse(r.body.toString());
      return {
        status: 201,
        json: {
          job_id: "job_lipsync",
          asset_type: "video",
          status: "generating",
          model: body.model ?? "kling-lipsync",
          prompt: body.script,
          generation_params: {
            source_mode: "lip_sync",
            ...(body.video_job_id ? { source_job_id: body.video_job_id } : {}),
            voice: body.voice ?? { provider: "xai", voice_id: "eve" },
            voice_source: body.voice ? "request" : "default",
          },
          estimated_cost_usd: 0.028,
        },
      };
    }
    if (route === "GET /api/v1/jobs") {
      return {
        json: {
          jobs: [{ job_id: "job_lipsync", asset_type: "video", status: "generating", model: "kling-lipsync", prompt: "Hi", generation_params: { source_mode: "lip_sync" } }],
          total: 1,
        },
      };
    }
    if (route === "GET /api/v1/pipelines/nodes") return { json: { max_nodes: 12, nodes: [LIP_SYNC_NODE] } };
    if (route === "GET /api/v1/pipelines/templates") return { json: { templates: TEMPLATES } };
    if (route === "GET /api/v1/pipelines/graphs") return { json: { graphs: [] } };
    if (route === "POST /api/v1/pipelines") {
      return {
        status: 201,
        json: {
          run: { run_id: "run_ls", status: "running" },
          stages: TEMPLATES[1].stages.map((stage_type) => ({ stage_type })),
          estimated_cost_usd: 0.72,
        },
      };
    }
    return undefined;
  };
}

function routeOf(r) {
  const path = r.path.replace(/^\/api\/v1\/jobs\/(?!enhance-prompt$|source-media$|lip-sync$)[^/]+$/, "/api/v1/jobs/:id");
  return `${r.method} ${path}`;
}

describe("lip-sync", () => {
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
    work = tempDir("adsopt-ls-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    work.cleanup();
    stub.requests.length = 0;
  });

  const lipSyncBodies = () =>
    stub.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/jobs/lip-sync").map((r) => JSON.parse(r.body.toString()));
  const clip = (name = "clip.mp4", bytes = MP4) => {
    const file = join(work.dir, name);
    writeFileSync(file, bytes);
    return file;
  };

  describe("sources", () => {
    const cases = [
      ["video_job_id", () => ({ video_job_id: "job_clip" }), { video_job_id: "job_clip" }],
      ["video_url", () => ({ video_url: "https://cdn.example.com/clip.mp4" }), { video_url: "https://cdn.example.com/clip.mp4" }],
      ["video_path", (file) => ({ video_path: file }), { video_url: UPLOADED }],
    ];
    for (const [label, source, expected] of cases) {
      it(`${label}: calls only its documented routes with the bearer token, and sends the connector's body`, async () => {
        const voice = { provider: "openai", voice: "cedar", instructions: "slow, warm" };
        const res = await ctx.call("adsoptimiser_lip_sync", {
          ...source(clip()),
          script: "  Morning. Best tomatoes in the county, and I've grown them for eighty years.  ",
          voice,
          character_id: "chr_amos",
          model: "kling-lipsync",
        });
        assert.equal(res.isError, false, res.text);
        for (const r of stub.requests) {
          assert.ok(TOOL_ROUTES.adsoptimiser_lip_sync.includes(routeOf(r)), `lip_sync called ${routeOf(r)}`);
          assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
        }
        assert.deepEqual(lipSyncBodies(), [
          {
            ...expected,
            script: "Morning. Best tomatoes in the county, and I've grown them for eighty years.",
            voice,
            character_id: "chr_amos",
            model: "kling-lipsync",
          },
        ]);
        assert.equal(res.structured.job_id, "job_lipsync");
        assert.equal(res.structured.estimated_cost_usd, 0.028);
        assert.equal(res.structured.model_label, "Kling LipSync");
        assert.match(res.text, /Job job_lipsync: lip-sync video generating \(Kling LipSync\)/);
        assert.match(res.text, /estimated provider cost US\$0\.03; uses one video generation/);
        assert.match(res.text, /adsoptimiser_get_job/);
        assert.ok(!res.text.includes(TOKEN));
      });
    }

    it("video_job_id is checked first and sent as is", async () => {
      await ctx.call("adsoptimiser_lip_sync", { video_job_id: "job_clip", script: "Hi" });
      assert.deepEqual(
        stub.requests.map((r) => `${r.method} ${r.path}`),
        ["GET /api/v1/jobs/job_clip", "POST /api/v1/jobs/lip-sync"]
      );
      assert.deepEqual(lipSyncBodies(), [{ video_job_id: "job_clip", script: "Hi" }]);
    });

    it("an unfinished source job is refused before anything is charged", async () => {
      const res = await ctx.call("adsoptimiser_lip_sync", { video_job_id: "job_busy", script: "Hi" });
      assert.equal(res.isError, true);
      assert.match(res.text, /generating/);
      assert.equal(lipSyncBodies().length, 0);
    });

    it("video_path uploads the clip as source_type video and sends its hosted URL", async () => {
      const file = clip("talk.mov");
      const res = await ctx.call("adsoptimiser_lip_sync", { video_path: file, script: "Hi" });
      assert.equal(res.isError, false, res.text);
      const uploads = stub.requests.filter((r) => r.path === "/api/v1/jobs/source-media");
      assert.equal(uploads.length, 1);
      const form = await stub.formData(uploads[0]);
      assert.equal(form.get("source_type"), "video");
      assert.equal(form.get("purpose"), null);
      assert.equal(form.get("file").name, "talk.mov");
      assert.equal(form.get("file").type, "video/quicktime");
      assert.deepEqual(lipSyncBodies(), [{ video_url: UPLOADED, script: "Hi" }]);
      assert.deepEqual(res.structured.upload, { path: file, video_url: UPLOADED });
      assert.match(res.text, /Uploaded .*talk\.mov as the source video/);
    });

    it("video_path is refused locally when missing, not a video, or over 100 MB", async () => {
      const big = join(work.dir, "big.mp4");
      const fd = openSync(big, "w");
      writeSync(fd, Buffer.from([1]), 0, 1, MAX_LIP_SYNC_VIDEO_BYTES); // sparse: 100 MB + 1 byte
      closeSync(fd);
      const image = join(work.dir, "still.png");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
      const cases = [
        [join(work.dir, "missing.mp4"), /File not found/],
        [image, /still\.png is an image, but a video is needed here/],
        [clip("clip.avi"), /unsupported file type/],
        [big, /100\.0 MB; lip-sync source videos are limited to 100 MB/],
      ];
      for (const [path, pattern] of cases) {
        const res = await ctx.call("adsoptimiser_lip_sync", { video_path: path, script: "Hi" });
        assert.equal(res.isError, true, path);
        assert.match(res.text, pattern);
      }
      assert.equal(stub.requests.length, 0);
    });

    it("needs exactly one of video_job_id, video_url or video_path", async () => {
      const file = clip();
      for (const args of [
        {},
        { video_job_id: "job_clip", video_url: "https://cdn.example.com/c.mp4" },
        { video_job_id: "job_clip", video_path: file },
        { video_url: "https://cdn.example.com/c.mp4", video_path: file },
      ]) {
        const res = await ctx.call("adsoptimiser_lip_sync", { ...args, script: "Hi" });
        assert.equal(res.isError, true);
        assert.match(res.text, /exactly one of video_job_id, video_url or video_path/);
      }
      assert.equal(stub.requests.length, 0);
    });
  });

  describe("input checks", () => {
    const invalid = [
      ["another model", { model: "sync-lipsync-2" }],
      ["an unknown model", { model: "wav2lip" }],
      ["an empty script", { script: "   " }],
      ["a script over 900 characters", { script: "a".repeat(901) }],
      ["an http URL", { video_url: "http://cdn.example.com/c.mp4", video_job_id: undefined }],
      ["a path-like job id", { video_job_id: "../x" }],
      ["a bad voice", { voice: { provider: "openai", voice: "robot" } }],
    ];
    for (const [label, override] of invalid) {
      it(`rejects ${label} before calling the API`, async () => {
        const res = await ctx.call("adsoptimiser_lip_sync", { video_job_id: "job_clip", script: "Hi", ...override });
        assert.equal(res.isError, true);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("offers kling-lipsync and sync-lipsync-2-pro, never the unverified Sync 2.0", async () => {
      const { tools } = await ctx.client.listTools();
      const tool = tools.find((t) => t.name === "adsoptimiser_lip_sync");
      assert.deepEqual(tool.inputSchema.properties.model.enum, ["kling-lipsync", "sync-lipsync-2-pro"]);
      assert.deepEqual(tool.inputSchema.required, ["script"]);
      assert.ok(!/sync-lipsync-2"|sync 2\.0/i.test(JSON.stringify(tool)));
      assert.match(tool.description, /mouth closed and still/);
      assert.match(tool.description, /2 to 10 seconds at 720p or 1080p/);
      assert.match(tool.description, /about 20 words for an 8 second clip/);
    });
  });

  describe("errors", () => {
    const cases = [
      [503, "lip_sync_not_configured", "Lip-sync isn't configured on this deployment.", /isn't configured on this Ads Optimiser deployment.*Nothing was charged.*generate_video with a script/],
      [400, "invalid_source_video", "Lip-sync input rejected: the clip is 480p", /can't be lip-synced: Lip-sync input rejected: the clip is 480p\. Kling LipSync needs a finished 2 to 10 second clip at 720p or 1080p/],
      [400, "invalid_audio", "Lip-sync input rejected: audio runs 70s", /speech can't be used.*2 to 60 seconds/],
      [400, "invalid_script", "Lip-sync input rejected: the spoken line runs 9.1s but the clip is only 6.0s", /doesn't fit the clip: .*9\.1s.*about 20 words.*Nothing was charged/],
      [400, "openai_voices_not_configured", "OpenAI voices are not configured", /OpenAI voices are not available.*xai.*eve/],
      [404, null, "Character not found", /Not found: Character not found\. Check video_job_id .*character_id/],
      [409, null, "The source video job is not ready yet", /isn't ready yet.*adsoptimiser_get_job/],
      [429, "plan_limit_exceeded", "Monthly video limit reached.", /Plan limit reached.*https:\/\/app\.example\.test\/#\/billing/],
      [429, "video_daily_quota_exceeded", "Daily video generation quota reached.", /Daily video quota reached/],
      [502, "tts_failed", "Speech synthesis failed: upstream 500", /could not be spoken \(Speech synthesis failed: upstream 500\)\. Nothing was charged/],
      [403, "token_scope_denied", "API tokens cannot use this route", /doesn't support lip-sync yet/],
    ];
    for (const [status, code, message, pattern] of cases) {
      it(`maps ${status} ${code ?? ""}`.trim(), async () => {
        state.lipSyncError = { status, json: { error: message, ...(code ? { code } : {}) } };
        const res = await ctx.call("adsoptimiser_lip_sync", { video_url: "https://cdn.example.com/c.mp4", script: "Hi" });
        assert.equal(res.isError, true);
        assert.match(res.text, pattern);
        assert.equal(res.structured.status, status);
        assert.equal(res.structured.code, code);
      });
    }
  });

  describe("job summaries", () => {
    it("get_job labels a lip-sync job and shows its voice", async () => {
      const res = await ctx.call("adsoptimiser_get_job", { job_id: "job_lipsync" });
      assert.match(res.text, /Job job_lipsync: lip-sync video ready \(Kling LipSync\)/);
      assert.match(res.text, /Lip-sync: spoken in openai cedar \(voice from character\), 6\.4s of speech, source video job job_clip\./);
      assert.match(res.text, /Voice instructions: slow and warm/);
      assert.equal(res.structured.model, "kling-lipsync");
      assert.equal(res.structured.lip_sync.voice, "openai cedar");
    });

    it("list_jobs marks lip-sync jobs", async () => {
      const res = await ctx.call("adsoptimiser_list_jobs", {});
      assert.match(res.text, /- job_lipsync lip-sync video generating/);
    });
  });

  describe("pipelines", () => {
    it("get_pipeline_nodes passes the lip_sync node through with its params by name", async () => {
      const res = await ctx.call("adsoptimiser_get_pipeline_nodes");
      assert.equal(res.isError, false, res.text);
      const node = res.structured.node_types.find((n) => n.type === "lip_sync");
      assert.deepEqual(node.inputs.map((i) => [i.name, i.kind, i.required]), [["video", "video", true], ["script", "text", false]]);
      assert.deepEqual(Object.keys(node.params), ["script", "voice", "voice_id", "model"]);
      assert.equal(node.params.script.max_length, 900);
      assert.deepEqual(node.params.model.enum, ["kling-lipsync"]);
      assert.equal(node.params.model.default, "kling-lipsync");
      assert.ok(Array.isArray(node.params.voice.one_of));
      assert.match(res.text, /- lip_sync \(Lip-sync \(character speaks your line\)\)\. Inputs: video:video\*, script:text\. Outputs: video:video\./);
      assert.match(res.text, /model \(kling-lipsync, default kling-lipsync\)/);
      assert.match(res.text, /voice \(object \{"provider":"xai","voice_id"\} \| \{"provider":"openai","voice","instructions"\?\}/);
      // The live catalogue sends no rules here, so the local ones explain lip_sync and the template.
      assert.match(res.text, /lip_sync re-animates the mouth/);
      assert.match(res.text, /character-lip-sync/);
    });

    it("the local fallback describes lip_sync when the API sends only enums", () => {
      const { params, ...rest } = LIP_SYNC_NODE;
      const node = compactNodeType(rest);
      assert.deepEqual(Object.keys(node.params).sort(), ["model", "script", "voice", "voice_id"]);
      assert.deepEqual(node.params.model.enum, ["kling-lipsync", "sync-lipsync-2-pro"]);
      assert.match(describeNodeType(node), /script \(max 900 chars\)/);
      assert.ok(GRAPH_RULES.some((r) => /Character talking clip \(designed voice\)/.test(r) && /US\$0\.72/.test(r)));
      assert.ok(!GRAPH_RULES.some((r) => /strip_audio then add_voiceover/.test(r)));
    });

    it("a lip_sync node needs the run prompt only when it has no script", () => {
      const base = { nodes: [{ id: "ls", type: "lip_sync" }], edges: [] };
      assert.equal(graphNeedsRunPrompt(base), true);
      assert.equal(graphNeedsRunPrompt({ nodes: [{ id: "ls", type: "lip_sync", params: { script: "Hi" } }], edges: [] }), false);
      assert.equal(
        graphNeedsRunPrompt({
          nodes: [{ id: "t", type: "text", params: { text: "Hi" } }, { id: "ls", type: "lip_sync" }],
          edges: [{ from: { node: "t", output: "text" }, to: { node: "ls", input: "script" } }],
        }),
        false
      );
    });

    it("list_pipelines shows the character-lip-sync template, and it runs with a character", async () => {
      const list = await ctx.call("adsoptimiser_list_pipelines");
      assert.match(
        list.text,
        /- character-lip-sync: Character talking clip \(designed voice\)\. .*\(pass character_id to adsoptimiser_run_pipeline\)/
      );
      const template = list.structured.templates.find((t) => t.template_id === "character-lip-sync");
      assert.equal(template.needs_character, true);

      const run = await ctx.call("adsoptimiser_run_pipeline", {
        template_id: "character-lip-sync",
        character_id: "chr_amos",
        prompt: "Morning. Best tomatoes in the county.",
      });
      assert.equal(run.isError, false, run.text);
      assert.match(run.text, /6 steps \(refine_prompt > character > generate_image > image_to_video > lip_sync > add_captions\)/);
      assert.match(run.text, /US\$0\.72/);
    });
  });
});
