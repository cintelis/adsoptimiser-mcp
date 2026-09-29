// The pipeline builder tools: node catalogue, get, validate, save, and runs
// from an inline graph, including local image paths in input_image nodes.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROUTES } from "../src/server.mjs";
import { compactNodeType, graphNeedsRunPrompt, localImageRefs, nodeIdsIn, shapeErrors } from "../src/pipeline.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const PROMPT = { name: "prompt", kind: "text", required: true, maxConnections: 1 };

/** The shape of GET /api/v1/pipelines/nodes (NODE_CATALOG in pipeline-graph.ts). */
const CATALOGUE = {
  max_nodes: 12,
  nodes: [
    { type: "text", label: "Text (fixed prompt)", inputs: [], outputs: [{ name: "text", kind: "text" }], constraints: ["Free."], enums: {} },
    {
      type: "generate_image",
      label: "Generate image",
      inputs: [PROMPT, { name: "refs", kind: "image", maxConnections: 5, description: "Up to 5 reference images." }],
      outputs: [{ name: "image", kind: "image" }],
      constraints: ["At most 5 reference images."],
      enums: { model: ["grok-imagine-image-2.0", "grok-imagine-image"], aspect_ratio: ["9:16", "1:1"], quality: ["low", "medium", "auto"] },
    },
    {
      type: "image_to_video",
      label: "Image to video",
      inputs: [PROMPT, { name: "image", kind: "image", required: true, maxConnections: 1 }],
      outputs: [{ name: "video", kind: "video" }],
      constraints: ["1080p requires grok-imagine-video-1.5."],
      enums: { model: ["grok-imagine-video-1.5", "grok-imagine-video"], resolution: ["480p", "720p", "1080p"] },
    },
    { type: "input_image", label: "Your image", inputs: [], outputs: [{ name: "image", kind: "image" }], constraints: [], enums: {} },
  ],
};
const KNOWN = new Set(CATALOGUE.nodes.map((n) => n.type));

/** The add_voiceover voice param exactly as NODE_CATALOG publishes it. */
const VOICE_PARAM = {
  name: "voice",
  type: "object",
  oneOf: [
    { provider: { const: "xai" }, voice_id: { enum: ["eve", "leo"] } },
    {
      provider: { const: "openai" },
      voice: { enum: ["cedar", "nova"] },
      instructions: { type: "string", maxLength: 1000, optional: true, description: "Accent, pacing." },
    },
  ],
  description: "Narrator voice profile.",
};

/** Current deployments publish params as an array per node (characters v2 and voices). */
const LIVE_CATALOGUE = {
  max_nodes: 12,
  nodes: [
    {
      type: "add_voiceover",
      label: "Add voiceover",
      inputs: [PROMPT, { name: "video", kind: "video", required: true, maxConnections: 1 }],
      outputs: [{ name: "video", kind: "video" }],
      constraints: ["Voice: the node's voice wins."],
      enums: { voice_id: ["eve", "leo"], audio_mode: ["replace", "mix"] },
      params: [
        { name: "script", type: "string", required: true, maxLength: 5000, description: "The words." },
        VOICE_PARAM,
        { name: "voice_id", type: "string", enum: ["eve", "leo"], description: "xAI preset." },
        { name: "audio_mode", type: "string", enum: ["replace", "mix"], default: "replace", description: "Mode." },
      ],
    },
    {
      type: "character",
      label: "Character",
      inputs: [],
      outputs: [{ name: "images", kind: "image", multi: true, description: "Only a refs input accepts it." }],
      constraints: ["Free."],
      enums: {},
      params: [{ name: "character_id", type: "string", required: true, description: "A saved character id." }],
    },
    {
      type: "add_captions",
      label: "Add captions",
      inputs: [
        { name: "video", kind: "video", required: true, maxConnections: 1 },
        { name: "text", kind: "text", maxConnections: 1, description: "Caption text." },
      ],
      outputs: [{ name: "video", kind: "video" }],
      constraints: ["Burns captions in."],
      enums: { position: ["bottom", "center", "top"] },
      params: [
        { name: "captions", type: "string", maxLength: 2000, description: "The words to show." },
        { name: "position", type: "string", enum: ["bottom", "center", "top"], default: "bottom", description: "Where." },
      ],
    },
    {
      type: "input_image",
      label: "Your image",
      inputs: [],
      outputs: [{ name: "image", kind: "image" }],
      constraints: [],
      enums: {},
      params: [{ name: "image_url", type: "string", required: true, description: "From the API." }],
    },
  ],
};

/** A text-fed image, animated: valid, needs no run prompt. */
const GRAPH = {
  version: 1,
  nodes: [
    { id: "copy", type: "text", params: { text: "A red sneaker on a plinth" } },
    { id: "img", type: "generate_image", params: { aspect_ratio: "9:16" } },
    { id: "vid", type: "image_to_video", params: { duration: 6 } },
  ],
  edges: [
    { from: { node: "copy", output: "text" }, to: { node: "img", input: "prompt" } },
    { from: { node: "copy", output: "text" }, to: { node: "vid", input: "prompt" } },
    { from: { node: "img", output: "image" }, to: { node: "vid", input: "image" } },
  ],
};

/** The same checks the worker's validateGraph makes for these tests' graphs. */
function validate(graph) {
  const errors = [];
  for (const node of graph?.nodes ?? []) {
    if (!KNOWN.has(node.type)) errors.push(`Unknown node type "${node.type}" on node "${node.id}"`);
    if (node.type === "input_image" && !/^https?:\/\//.test(node.params?.image_url ?? "")) {
      errors.push(`node "${node.id}": image must be an http(s) URL or a data:image URI`);
    }
  }
  if ((graph?.nodes ?? []).length > 12) errors.push(`Graph exceeds the 12-node limit (has ${graph.nodes.length})`);
  return errors;
}

let uploads = 0;
function fakeApi(r) {
  const route = `${r.method} ${r.path}`;
  const json = () => JSON.parse(r.body.toString());
  if (route === "GET /api/v1/pipelines/nodes") return { json: CATALOGUE };
  if (route === "POST /api/v1/pipelines/graphs/validate") {
    const errors = validate(json().graph);
    return { json: { ok: errors.length === 0, errors, estimated_cost_usd: errors.length ? null : 0.53 } };
  }
  if (route === "POST /api/v1/pipelines/graphs") {
    const body = json();
    const errors = validate(body.graph);
    if (errors.length) return { status: 400, json: { error: "Invalid graph", errors } };
    return { status: 201, json: { graph_id: "pg_new", name: body.name, description: body.description ?? "", graph: body.graph } };
  }
  if (route === "PATCH /api/v1/pipelines/graphs/pg_1") {
    const body = json();
    const errors = validate(body.graph);
    if (errors.length) return { status: 400, json: { error: "Invalid graph", errors } };
    return { json: { graph_id: "pg_1", name: body.name, description: body.description ?? "", graph: body.graph } };
  }
  if (route === "GET /api/v1/pipelines/graphs/pg_1") {
    return { json: { graph_id: "pg_1", name: "Sneaker spin", description: "d", graph: GRAPH, updated_at: "2026-09-01T00:00:00Z", estimated_cost_usd: 0.53 } };
  }
  if (route === "POST /api/v1/pipelines") {
    const body = json();
    const nodes = body.graph?.nodes ?? [{ type: "generate_image" }];
    return {
      status: 201,
      json: { run: { run_id: "run_9", status: "running" }, stages: nodes.map((n) => ({ stage_type: n.type })), estimated_cost_usd: 0.53 },
    };
  }
  if (route === "POST /api/v1/jobs/source-media") {
    uploads += 1;
    return { json: { source_url: `https://api.example.test/media/sources%2Fsrc_${uploads}.png`, key: `sources/src_${uploads}.png`, bytes: 16 } };
  }
  return undefined;
}

function routeOf(r) {
  const path = r.path.replace(/^\/api\/v1\/pipelines\/graphs\/(?!validate$)[^/]+$/, "/api/v1/pipelines/graphs/:graph_id");
  return `${r.method} ${path}`;
}

describe("pipeline builder tools", () => {
  let stub;
  let ctx;
  let work;
  before(async () => {
    stub = await startStub(fakeApi);
  });
  after(async () => {
    await stub.close();
  });
  beforeEach(async () => {
    work = tempDir("adsopt-graph-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx?.close();
    work.cleanup();
    stub.requests.length = 0;
    stub.setHandler(fakeApi);
  });

  const posts = (path) => stub.requests.filter((r) => r.method === "POST" && r.path === path);
  const patches = (path) => stub.requests.filter((r) => r.method === "PATCH" && r.path === path);
  const bodyOf = (r) => JSON.parse(r.body.toString());

  const calls = [
    ["adsoptimiser_get_pipeline_nodes", {}],
    ["adsoptimiser_get_pipeline", { graph_id: "pg_1" }],
    ["adsoptimiser_validate_pipeline", { graph: GRAPH }],
    ["adsoptimiser_save_pipeline", { name: "Sneaker spin", graph: GRAPH }],
    ["adsoptimiser_save_pipeline", { name: "Sneaker spin", graph: GRAPH, graph_id: "pg_1" }],
    ["adsoptimiser_run_pipeline", { graph: GRAPH }],
  ];
  for (const [name, args] of calls) {
    it(`${name}${name.endsWith("save_pipeline") && args.graph_id ? " (update)" : ""} calls only its documented routes, with the bearer token`, async () => {
      const res = await ctx.call(name, args);
      assert.equal(res.isError, false, res.text);
      assert.ok(stub.requests.length > 0);
      for (const r of stub.requests) {
        assert.ok(TOOL_ROUTES[name].includes(routeOf(r)), `${name} called ${routeOf(r)}`);
        assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
      }
      assert.ok(!res.text.includes(TOKEN));
    });
  }

  it("get_pipeline_nodes returns a compact catalogue, the graph rules and an example", async () => {
    const res = await ctx.call("adsoptimiser_get_pipeline_nodes");
    const { structured } = res;
    assert.equal(structured.max_nodes, 12);
    assert.deepEqual(
      structured.node_types.map((n) => n.type),
      ["text", "generate_image", "image_to_video", "input_image"]
    );
    const i2v = structured.node_types.find((n) => n.type === "image_to_video");
    assert.deepEqual(i2v.inputs[1], { name: "image", kind: "image", required: true, max_connections: 1 });
    assert.deepEqual(i2v.params.resolution.enum, ["480p", "720p", "1080p"]);
    assert.equal(i2v.params.duration.min, 1);
    assert.equal(i2v.params.duration.max, 15);
    const img = structured.node_types.find((n) => n.type === "generate_image");
    assert.equal(img.inputs[1].max_connections, 5);
    assert.equal(structured.node_types.find((n) => n.type === "text").params.text.required, true);
    assert.match(structured.node_types.find((n) => n.type === "input_image").params.image_url.description, /local file path/);
    assert.ok(structured.rules.some((r) => /At most 12 nodes/.test(r)));
    assert.ok(structured.rules.some((r) => /run prompt/.test(r)));
    assert.equal(structured.example.graph.version, 1);
    assert.match(res.text, /- image_to_video \(Image to video\)\. Inputs: prompt:text\*, image:image\*\. Outputs: video:video\./);
    assert.match(res.text, /refs:image x5/);
    assert.match(res.text, /adsoptimiser_validate_pipeline/);
  });

  it("get_pipeline_nodes keeps the live catalogue's params, including character, add_captions and the voice oneOf", async () => {
    stub.setHandler((r) =>
      r.path === "/api/v1/pipelines/nodes" ? { json: LIVE_CATALOGUE } : fakeApi(r)
    );
    const res = await ctx.call("adsoptimiser_get_pipeline_nodes");
    assert.equal(res.isError, false, res.text);
    const byType = Object.fromEntries(res.structured.node_types.map((n) => [n.type, n]));
    assert.deepEqual(Object.keys(byType), ["add_voiceover", "character", "add_captions", "input_image"]);

    const vo = byType.add_voiceover;
    assert.deepEqual(Object.keys(vo.params), ["script", "voice", "voice_id", "audio_mode"]);
    assert.deepEqual(vo.params.voice.one_of, VOICE_PARAM.oneOf);
    assert.equal(vo.params.voice.type, "object");
    assert.equal(vo.params.script.max_length, 5000);
    assert.equal(vo.params.script.required, true);
    assert.deepEqual(vo.params.voice_id.enum, ["eve", "leo"]);
    assert.equal(vo.params.audio_mode.default, "replace");

    assert.equal(byType.character.params.character_id.required, true);
    assert.deepEqual(byType.character.outputs, [
      { name: "images", kind: "image", description: "Only a refs input accepts it." },
    ]);
    assert.deepEqual(byType.add_captions.params.position.enum, ["bottom", "center", "top"]);
    assert.equal(byType.add_captions.params.captions.max_length, 2000);
    assert.deepEqual(byType.add_captions.inputs[1], {
      name: "text",
      kind: "text",
      required: false,
      max_connections: 1,
      description: "Caption text.",
    });
    // The API's description, plus what this local server adds.
    assert.match(byType.input_image.params.image_url.description, /^From the API\. .*absolute local file path/);

    assert.match(
      res.text,
      /voice \(object \{"provider":"xai","voice_id"\} \| \{"provider":"openai","voice","instructions"\?\}, see adsoptimiser_list_voices\)/
    );
    assert.match(res.text, /audio_mode \(replace\|mix, default replace\)/);
    assert.match(res.text, /- character \(Character\)\. Inputs: none\. Outputs: images:image\./);
    assert.ok(res.structured.rules.some((r) => /character node/.test(r)));
    assert.ok(res.structured.rules.some((r) => /add_captions burns text/.test(r)));
    assert.ok(res.structured.rules.some((r) => /add_voiceover voice:.*else eve/.test(r)));
  });

  it("the enums-only fallback still describes character, add_captions and the voice param", () => {
    const vo = compactNodeType({ type: "add_voiceover", label: "Voiceover", enums: { voice_id: ["eve"] } });
    assert.equal(vo.params.voice.type, "object");
    assert.equal(vo.params.voice.one_of.length, 3);
    assert.deepEqual(vo.params.voice_id.enum, ["eve"]);
    const captions = compactNodeType({ type: "add_captions", label: "Captions", enums: { position: ["bottom"] } });
    assert.deepEqual(captions.params.position.enum, ["bottom"]);
    assert.equal(captions.params.captions.max_length, 2000);
    const character = compactNodeType({ type: "character", label: "Character" });
    assert.equal(character.params.character_id.required, true);
  });

  it("get_pipeline returns the saved graph, node count and cost", async () => {
    const res = await ctx.call("adsoptimiser_get_pipeline", { graph_id: "pg_1" });
    assert.equal(res.structured.graph_id, "pg_1");
    assert.equal(res.structured.node_count, 3);
    assert.equal(res.structured.estimated_cost_usd, 0.53);
    assert.equal(res.structured.needs_run_prompt, false);
    assert.deepEqual(res.structured.graph, GRAPH);
    assert.equal(res.structured.editor_url, "https://app.example.test/#/pipeline-editor");
    assert.match(res.text, /3 nodes, estimated provider cost about US\$0\.53 per run/);
  });

  it("validate_pipeline sends { graph } and reports validity, cost, node count and the run prompt", async () => {
    const { edges, version, ...bare } = GRAPH;
    const res = await ctx.call("adsoptimiser_validate_pipeline", { graph: { ...bare, edges } });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(bodyOf(posts("/api/v1/pipelines/graphs/validate")[0]), { graph: GRAPH });
    assert.deepEqual(res.structured, {
      valid: true,
      errors: [],
      estimated_cost_usd: 0.53,
      node_count: 3,
      needs_run_prompt: false,
    });
    assert.match(res.text, /valid: 3 nodes.*US\$0\.53 per run.*needs no prompt/);
    assert.equal(posts("/api/v1/pipelines").length, 0);
  });

  it("validate_pipeline surfaces validator errors with node ids", async () => {
    const graph = { nodes: [{ id: "a", type: "generate_image" }, { id: "b", type: "make_magic" }], edges: [] };
    const res = await ctx.call("adsoptimiser_validate_pipeline", { graph });
    assert.equal(res.isError, true);
    assert.equal(res.structured.valid, false);
    assert.deepEqual(res.structured.errors, [{ message: 'Unknown node type "make_magic" on node "b"', node_ids: ["b"] }]);
    assert.equal(res.structured.needs_run_prompt, true);
    assert.match(res.text, /not valid \(1 problem\)/);
  });

  it("save_pipeline PATCHes an update by graph_id and POSTs a new pipeline, and links to the editor", async () => {
    const res = await ctx.call("adsoptimiser_save_pipeline", {
      name: "Sneaker spin",
      description: "Text to image to video",
      graph: GRAPH,
      graph_id: "pg_1",
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(posts("/api/v1/pipelines/graphs").length, 0);
    assert.deepEqual(bodyOf(patches("/api/v1/pipelines/graphs/pg_1")[0]), {
      name: "Sneaker spin",
      description: "Text to image to video",
      graph: GRAPH,
    });
    assert.equal(res.structured.graph_id, "pg_1");
    assert.equal(res.structured.editor_url, "https://app.example.test/#/pipeline-editor");
    assert.match(res.text, /Updated pipeline "Sneaker spin" as pg_1/);

    const created = await ctx.call("adsoptimiser_save_pipeline", { name: "New", graph: GRAPH });
    assert.equal(created.structured.graph_id, "pg_new");
    assert.deepEqual(bodyOf(posts("/api/v1/pipelines/graphs")[0]), { name: "New", graph: GRAPH });
    assert.equal(patches("/api/v1/pipelines/graphs/pg_1").length, 1);
    assert.match(created.text, /Saved pipeline "New" as pg_new/);
  });

  it("save_pipeline surfaces the API's graph errors on update too", async () => {
    const res = await ctx.call("adsoptimiser_save_pipeline", {
      name: "Bad",
      graph_id: "pg_1",
      graph: { nodes: [{ id: "y", type: "levitate" }] },
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /Unknown node type "levitate" on node "y"/);
  });

  it("validate_pipeline prefers node_count and needs_run_prompt from the API when sent", async () => {
    stub.setHandler((r) =>
      r.path === "/api/v1/pipelines/graphs/validate"
        ? { json: { ok: true, errors: [], estimated_cost_usd: 0.1, node_count: 7, needs_run_prompt: true } }
        : undefined
    );
    const res = await ctx.call("adsoptimiser_validate_pipeline", { graph: GRAPH });
    assert.equal(res.structured.node_count, 7);
    assert.equal(res.structured.needs_run_prompt, true);
  });

  it("save_pipeline surfaces the API's graph errors", async () => {
    const res = await ctx.call("adsoptimiser_save_pipeline", {
      name: "Bad",
      graph: { nodes: [{ id: "x", type: "teleport" }] },
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /rejected: Invalid graph\n- Unknown node type "teleport" on node "x"/);
    assert.deepEqual(res.structured.errors[0].node_ids, ["x"]);
  });

  describe("run_pipeline", () => {
    it("needs exactly one of template_id, graph_id or graph", async () => {
      for (const args of [
        {},
        { template_id: "product-ad", graph: GRAPH },
        { graph_id: "pg_1", template_id: "product-ad" },
        { graph_id: "pg_1", graph: GRAPH, template_id: "product-ad" },
      ]) {
        const res = await ctx.call("adsoptimiser_run_pipeline", args);
        assert.equal(res.isError, true, JSON.stringify(args));
        assert.match(res.text, /exactly one of template_id, graph_id .* or graph/);
      }
      assert.equal(stub.requests.length, 0);
    });

    it("validates an inline graph, then runs it and reports steps, cost and allowance", async () => {
      const res = await ctx.call("adsoptimiser_run_pipeline", { graph: GRAPH, prompt: "Summer sale" });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(
        stub.requests.map((r) => routeOf(r)),
        ["POST /api/v1/pipelines/graphs/validate", "POST /api/v1/pipelines"]
      );
      assert.deepEqual(bodyOf(posts("/api/v1/pipelines")[0]), { graph: GRAPH, prompt: "Summer sale" });
      assert.equal(res.structured.step_count, 3);
      assert.equal(res.structured.estimated_cost_usd, 0.53);
      assert.match(res.text, /3 steps \(text > generate_image > image_to_video\)/);
      assert.match(res.text, /US\$0\.53/);
      assert.match(res.text, /plan allowance/);
    });

    it("does not run an invalid inline graph and surfaces the validator's errors", async () => {
      const res = await ctx.call("adsoptimiser_run_pipeline", {
        graph: { nodes: [{ id: "q", type: "quantum_render" }] },
        prompt: "x",
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /Not run: The graph is not valid/);
      assert.match(res.text, /Unknown node type "quantum_render" on node "q"/);
      assert.deepEqual(res.structured.errors[0].node_ids, ["q"]);
      assert.equal(posts("/api/v1/pipelines").length, 0);
    });

    it("asks for a prompt when an inline graph has an unwired prompt input", async () => {
      const res = await ctx.call("adsoptimiser_run_pipeline", {
        graph: { nodes: [{ id: "img", type: "generate_image" }] },
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /needs a prompt/);
      assert.equal(posts("/api/v1/pipelines").length, 0);
    });

    it("still runs templates and saved graphs without validating", async () => {
      await ctx.call("adsoptimiser_run_pipeline", { graph_id: "pg_1", prompt: "p" });
      await ctx.call("adsoptimiser_run_pipeline", { template_id: "product-ad", prompt: "p" });
      assert.deepEqual(
        posts("/api/v1/pipelines").map(bodyOf),
        [
          { graph_id: "pg_1", prompt: "p" },
          { template_id: "product-ad", prompt: "p" },
        ]
      );
      assert.equal(posts("/api/v1/pipelines/graphs/validate").length, 0);
    });
  });

  describe("local files in input_image nodes", () => {
    const withImage = (params) => ({
      nodes: [
        { id: "photo", type: "input_image", params },
        { id: "vid", type: "image_to_video" },
      ],
      edges: [{ from: { node: "photo", output: "image" }, to: { node: "vid", input: "image" } }],
    });

    it("uploads a local image_url and substitutes the hosted URL before validating and running", async () => {
      const file = join(work.dir, "product.png");
      writeFileSync(file, PNG);
      const validated = await ctx.call("adsoptimiser_validate_pipeline", { graph: withImage({ image_url: file }) });
      assert.equal(validated.isError, false, validated.text);
      const uploaded = posts("/api/v1/jobs/source-media");
      assert.equal(uploaded.length, 1);
      const form = await stub.formData(uploaded[0]);
      assert.equal(form.get("source_type"), "image");
      assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), PNG);

      const hosted = validated.structured.uploads[0].image_url;
      assert.match(hosted, /^https:\/\/api\.example\.test\/media\//);
      const sent = bodyOf(posts("/api/v1/pipelines/graphs/validate")[0]).graph;
      assert.deepEqual(sent.nodes[0].params, { image_url: hosted });
      assert.equal(validated.structured.graph.nodes[0].params.image_url, hosted);
      assert.match(validated.text, /Uploaded 1 local image for input_image nodes \(photo\)/);

      // Running the same graph again reuses the upload.
      const run = await ctx.call("adsoptimiser_run_pipeline", { graph: withImage({ image_url: file }), prompt: "spin it" });
      assert.equal(run.isError, false, run.text);
      assert.equal(posts("/api/v1/jobs/source-media").length, 1);
      assert.equal(bodyOf(posts("/api/v1/pipelines")[0]).graph.nodes[0].params.image_url, hosted);
    });

    it("accepts image_path too and removes it from the graph", async () => {
      const file = join(work.dir, "hero.png");
      writeFileSync(file, PNG);
      const res = await ctx.call("adsoptimiser_save_pipeline", {
        name: "Hero",
        graph: withImage({ image_path: file }),
      });
      assert.equal(res.isError, false, res.text);
      const saved = bodyOf(posts("/api/v1/pipelines/graphs")[0]).graph;
      assert.deepEqual(Object.keys(saved.nodes[0].params), ["image_url"]);
      assert.match(saved.nodes[0].params.image_url, /^https:\/\//);
    });

    it("leaves https URLs alone", async () => {
      await ctx.call("adsoptimiser_validate_pipeline", {
        graph: withImage({ image_url: "https://cdn.example.com/p.png" }),
      });
      assert.equal(posts("/api/v1/jobs/source-media").length, 0);
      assert.equal(
        bodyOf(posts("/api/v1/pipelines/graphs/validate")[0]).graph.nodes[0].params.image_url,
        "https://cdn.example.com/p.png"
      );
    });

    it("refuses a missing file before anything is sent", async () => {
      const res = await ctx.call("adsoptimiser_run_pipeline", {
        graph: withImage({ image_url: join(work.dir, "nope.png") }),
        prompt: "x",
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /File not found/);
      assert.equal(stub.requests.length, 0);
    });
  });

  describe("deployments without the builder routes", () => {
    const denied = { status: 403, json: { error: "API tokens cannot use this route", code: "token_scope_denied" } };

    for (const [name, args] of [
      ["adsoptimiser_get_pipeline_nodes", {}],
      ["adsoptimiser_get_pipeline", { graph_id: "pg_1" }],
      ["adsoptimiser_validate_pipeline", { graph: GRAPH }],
      ["adsoptimiser_save_pipeline", { name: "n", graph: GRAPH }],
      ["adsoptimiser_save_pipeline", { name: "n", graph: GRAPH, graph_id: "pg_1" }],
      ["adsoptimiser_run_pipeline", { graph: GRAPH }],
    ]) {
      it(`${name}${name.endsWith("save_pipeline") && args.graph_id ? " (update)" : ""} says pipeline building is not supported yet`, async () => {
        stub.setHandler(() => denied);
        const res = await ctx.call(name, args);
        assert.equal(res.isError, true);
        assert.match(res.text, /this deployment doesn't support pipeline building yet/i);
        assert.equal(res.structured.code, "token_scope_denied");
      });
    }

    it("keeps the general message for template runs", async () => {
      stub.setHandler(() => denied);
      const res = await ctx.call("adsoptimiser_run_pipeline", { template_id: "product-ad", prompt: "x" });
      assert.equal(res.isError, true);
      assert.doesNotMatch(res.text, /pipeline building/);
      assert.match(res.text, /does not allow that with an API token/);
    });
  });
});

describe("pipeline helpers", () => {
  it("finds node ids in validator messages", () => {
    assert.deepEqual(nodeIdsIn('node "img": quality only applies to image nodes'), ["img"]);
    assert.deepEqual(nodeIdsIn('Duplicate node id "a"'), ["a"]);
    assert.deepEqual(nodeIdsIn('Node id "bad-id" must be 1-40 characters'), ["bad-id"]);
    assert.deepEqual(nodeIdsIn("edge a.text → b.prompt: cannot connect text output to image input"), ["a", "b"]);
    assert.deepEqual(nodeIdsIn("Graph contains a cycle"), []);
    assert.deepEqual(shapeErrors([{ message: "m", node_id: "z" }]), [{ message: "m", node_ids: ["z"] }]);
  });

  it("knows when a graph needs the run prompt", () => {
    assert.equal(graphNeedsRunPrompt(GRAPH), false);
    assert.equal(graphNeedsRunPrompt({ nodes: [{ id: "a", type: "generate_image" }], edges: [] }), true);
    assert.equal(
      graphNeedsRunPrompt({ nodes: [{ id: "v", type: "voiced_video", params: { script: "Hi" } }], edges: [] }),
      false
    );
    assert.equal(graphNeedsRunPrompt({ nodes: [{ id: "s", type: "strip_audio" }], edges: [] }), false);
  });

  it("only treats non-URL image_url values as local files", () => {
    const refs = localImageRefs({
      nodes: [
        { id: "a", type: "input_image", params: { image_url: "https://x.test/a.png" } },
        { id: "b", type: "input_image", params: { image_url: "data:image/png;base64,AAAA" } },
        { id: "c", type: "input_image", params: { image_url: "C:\\photos\\c.png" } },
        { id: "d", type: "input_image", params: { image_path: "/tmp/d.png" } },
        { id: "e", type: "generate_image", params: { image_url: "/tmp/e.png" } },
      ],
    });
    assert.deepEqual(
      refs.map((r) => [r.node.id, r.path]),
      [
        ["c", "C:\\photos\\c.png"],
        ["d", "/tmp/d.png"],
      ]
    );
  });
});
