// Characters and voices: the connector's character and voice tools, plus the
// local-file extras (image_paths on create/update, save_to on preview_voice),
// and character_id / script on the generate and pipeline tools.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHARACTER_IMAGES, TOOL_ROUTES } from "../src/server.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const MP3 = Buffer.from("ID3 fake mp3 bytes");
const PREVIEW_KEY = "voice-previews/abc123.mp3";

const AMOS = {
  character_id: "chr_amos",
  workspace_id: "ws_1",
  name: "Amos",
  description: "101-year-old farmer, long white beard",
  style: "natural light",
  image_urls: ["https://api.example.test/media/a.png"],
  images: [{ url: "https://api.example.test/media/a.png", job_id: "job_a" }],
  voice: { provider: "openai", voice: "cedar", instructions: "slow and warm", xai_voice_id: "rex" },
  default_voice_id: "rex",
  updated_at: "2026-09-27T00:00:00Z",
};

const VOICES = {
  voices: [{ provider: "xai", voice_id: "eve", label: "Eve", default: true, available: true }],
  providers: {
    xai: { configured: true, voice_ids: ["eve", "leo", "rex"], default_voice_id: "eve" },
    openai: { configured: true, model: "gpt-4o-mini-tts", voices: ["cedar", "nova"] },
  },
  preview: { max_text_length: 300, per_minute: 10, default_text: "Hi there" },
  rules: ["Talking videos speak xAI presets only."],
};

function makeApi(state) {
  let uploads = 0;
  return (r) => {
    const route = `${r.method} ${r.path}`;
    const json = () => JSON.parse(r.body.toString());
    if (route === "POST /api/v1/jobs/source-media") {
      uploads += 1;
      return { json: { source_url: `https://api.example.test/media/sources%2Fsrc_${uploads}.png`, key: `sources/src_${uploads}.png`, bytes: 16 } };
    }
    if (route === "GET /api/v1/characters") return { json: { characters: [AMOS, { character_id: "chr_2", name: "Bea", image_urls: ["https://x.test/b.png"], voice: { provider: "xai", voice_id: "leo" } }] } };
    if (route === "GET /api/v1/characters/chr_amos") return { json: AMOS };
    if (route === "POST /api/v1/characters") {
      const body = json();
      if (state.characterError) return state.characterError;
      return { status: 201, json: { ...AMOS, ...body, character_id: "chr_new", images: undefined } };
    }
    if (route === "PATCH /api/v1/characters/chr_amos") {
      if (state.characterError) return state.characterError;
      return { json: { ...AMOS, ...json(), images: undefined } };
    }
    if (route === "GET /api/v1/voices") return { json: VOICES };
    if (route === "POST /api/v1/voices/preview") {
      if (state.previewError) return state.previewError;
      const body = json();
      return {
        json: {
          media_url: state.previewUrl ?? `https://api.example.test/media/${encodeURIComponent(PREVIEW_KEY)}`,
          ...(state.noStorageUri ? {} : { storage_uri: PREVIEW_KEY }),
          content_type: "audio/mpeg",
          voice: body.voice,
          text: body.text ?? "Hi there, this is a sample.",
          cached: false,
        },
      };
    }
    if (route === `GET /media/${encodeURIComponent(PREVIEW_KEY)}`) {
      return { headers: { "content-type": "audio/mpeg" }, body: MP3 };
    }
    if (route === "POST /api/v1/jobs") {
      const body = json();
      return {
        status: 201,
        json: {
          job_id: body.asset_type === "image" ? "job_new_img" : "job_new_vid",
          asset_type: body.asset_type,
          status: "queued",
          model: body.model,
          prompt: body.prompt,
          generation_params: state.voiceNote ? { voice_note: state.voiceNote } : {},
        },
      };
    }
    if (route === "GET /api/v1/jobs/job_img") {
      return { json: { job_id: "job_img", asset_type: "image", status: "ready", storage_uri: "images/job_img.png" } };
    }
    if (route === "GET /api/v1/pipelines/templates") {
      return {
        json: {
          templates: [
            { id: "product-ad", name: "Product ad", description: "d", stages: ["image"] },
            { id: "character-talking-clip", name: "Talking clip", description: "c", stages: ["character", "voiced_video"], needs_character: true },
          ],
        },
      };
    }
    if (route === "GET /api/v1/pipelines/graphs") return { json: { graphs: [] } };
    if (route === "POST /api/v1/pipelines") {
      return { status: 201, json: { run: { run_id: "run_c", status: "running" }, stages: [{ stage_type: "character" }, { stage_type: "voiced_video" }] } };
    }
    return undefined;
  };
}

function routeOf(r) {
  const path = r.path
    .replace(/^\/api\/v1\/characters\/[^/]+$/, "/api/v1/characters/:character_id")
    .replace(/^\/api\/v1\/jobs\/(?!enhance-prompt$|source-media$)[^/]+$/, "/api/v1/jobs/:id")
    .replace(/^\/media\/[^/]+$/, "/media/:key");
  return `${r.method} ${path}`;
}

describe("characters and voices", () => {
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
    work = tempDir("adsopt-chr-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    work.cleanup();
    stub.requests.length = 0;
  });

  const bodyOf = (r) => JSON.parse(r.body.toString());
  const requests = (method, path) => stub.requests.filter((r) => r.method === method && r.path === path);
  const png = (name) => {
    const file = join(work.dir, name);
    writeFileSync(file, PNG);
    return file;
  };

  const calls = [
    ["adsoptimiser_list_characters", {}],
    ["adsoptimiser_get_character", { character_id: "chr_amos" }],
    ["adsoptimiser_create_character", { name: "Amos", job_ids: ["job_a"] }],
    ["adsoptimiser_update_character", { character_id: "chr_amos", style: "grainy film" }],
    ["adsoptimiser_list_voices", {}],
    ["adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "leo" } }],
  ];
  for (const [name, args] of calls) {
    it(`${name} calls only its documented routes, with the bearer token`, async () => {
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

  describe("reading characters", () => {
    it("list_characters summarises each character and its voice", async () => {
      const res = await ctx.call("adsoptimiser_list_characters");
      assert.match(res.text, /2 character\(s\)/);
      assert.match(res.text, /chr_amos: Amos \(1 image\(s\), voice openai cedar \(talking videos: rex\)\): 101-year-old/);
      assert.match(res.text, /chr_2: Bea \(1 image\(s\), voice leo\)/);
      assert.deepEqual(res.structured.characters[1].images, [{ url: "https://x.test/b.png", job_id: null }]);
    });

    it("get_character shows every image, its job and the voice instructions", async () => {
      const res = await ctx.call("adsoptimiser_get_character", { character_id: "chr_amos" });
      assert.equal(res.structured.character_id, "chr_amos");
      assert.equal(res.structured.image_count, 1);
      assert.deepEqual(res.structured.voice, AMOS.voice);
      assert.match(res.text, /Voice instructions: slow and warm/);
      assert.match(res.text, /- https:\/\/api\.example\.test\/media\/a\.png \(from job_a\)/);
    });

    it("rejects a character id that could form a path", async () => {
      const res = await ctx.call("adsoptimiser_get_character", { character_id: "../x" });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  });

  describe("create_character and update_character", () => {
    it("create sends the connector's body shape", async () => {
      const voice = { provider: "openai", voice: "cedar", instructions: "slow, warm", xai_voice_id: "rex" };
      const res = await ctx.call("adsoptimiser_create_character", {
        name: "Amos",
        description: "farmer",
        style: "film",
        image_urls: ["https://cdn.example.com/1.png"],
        job_ids: ["job_a", "job_b"],
        voice,
      });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(bodyOf(requests("POST", "/api/v1/characters")[0]), {
        name: "Amos",
        description: "farmer",
        style: "film",
        image_urls: ["https://cdn.example.com/1.png"],
        job_ids: ["job_a", "job_b"],
        voice,
      });
      assert.equal(res.structured.character_id, "chr_new");
      assert.match(res.text, /Use character_id chr_new with adsoptimiser_generate_image/);
    });

    it("create uploads image_paths and passes their hosted URLs after image_urls", async () => {
      const res = await ctx.call("adsoptimiser_create_character", {
        name: "Amos",
        image_paths: [png("front.png"), png("side.png")],
        image_urls: ["https://cdn.example.com/1.png"],
        job_ids: ["job_a"],
        default_voice_id: "rex",
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(requests("POST", "/api/v1/jobs/source-media").length, 2);
      const body = bodyOf(requests("POST", "/api/v1/characters")[0]);
      assert.deepEqual(body, {
        name: "Amos",
        image_urls: [
          "https://cdn.example.com/1.png",
          "https://api.example.test/media/sources%2Fsrc_1.png",
          "https://api.example.test/media/sources%2Fsrc_2.png",
        ],
        job_ids: ["job_a"],
        default_voice_id: "rex",
      });
      assert.equal("image_paths" in body, false);
      assert.match(res.text, /Uploaded 2 local images/);
    });

    it("update with image_paths alone replaces the image list with the uploads", async () => {
      const res = await ctx.call("adsoptimiser_update_character", {
        character_id: "chr_amos",
        image_paths: [png("older.png")],
      });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(bodyOf(requests("PATCH", "/api/v1/characters/chr_amos")[0]), {
        image_urls: ["https://api.example.test/media/sources%2Fsrc_1.png"],
      });
    });

    it("update can clear the voice with null", async () => {
      await ctx.call("adsoptimiser_update_character", { character_id: "chr_amos", voice: null });
      assert.deepEqual(bodyOf(requests("PATCH", "/api/v1/characters/chr_amos")[0]), { voice: null });
    });

    it("the same local file is uploaded once per session", async () => {
      const file = png("front.png");
      await ctx.call("adsoptimiser_create_character", { name: "A", image_paths: [file] });
      await ctx.call("adsoptimiser_update_character", { character_id: "chr_amos", image_paths: [file] });
      assert.equal(requests("POST", "/api/v1/jobs/source-media").length, 1);
    });

    const overCap = [
      ["create", "adsoptimiser_create_character", { name: "A" }],
      ["update", "adsoptimiser_update_character", { character_id: "chr_amos" }],
    ];
    for (const [label, name, base] of overCap) {
      it(`${label} refuses more than ${MAX_CHARACTER_IMAGES} images across image_paths, image_urls and job_ids, before any upload`, async () => {
        const res = await ctx.call(name, {
          ...base,
          image_paths: [png("1.png"), png("2.png")],
          image_urls: ["https://cdn.example.com/3.png", "https://cdn.example.com/4.png"],
          job_ids: ["job_5", "job_6"],
        });
        assert.equal(res.isError, true);
        assert.match(res.text, /at most 5 reference images \(image_paths, image_urls and job_ids combined\)/);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("allows exactly 5 images across the three sources", async () => {
      const res = await ctx.call("adsoptimiser_create_character", {
        name: "A",
        image_paths: [png("1.png"), png("2.png")],
        image_urls: ["https://cdn.example.com/3.png"],
        job_ids: ["job_4", "job_5"],
      });
      assert.equal(res.isError, false, res.text);
      const body = bodyOf(requests("POST", "/api/v1/characters")[0]);
      assert.equal(body.image_urls.length + body.job_ids.length, 5);
    });

    it("create needs at least one image", async () => {
      const res = await ctx.call("adsoptimiser_create_character", { name: "A" });
      assert.equal(res.isError, true);
      assert.match(res.text, /at least one of image_paths, image_urls or job_ids/);
      assert.equal(stub.requests.length, 0);
    });

    it("update needs at least one field", async () => {
      const res = await ctx.call("adsoptimiser_update_character", { character_id: "chr_amos" });
      assert.equal(res.isError, true);
      assert.match(res.text, /Nothing to update/);
      assert.equal(stub.requests.length, 0);
    });

    it("checks every local image before uploading any", async () => {
      const res = await ctx.call("adsoptimiser_create_character", {
        name: "A",
        image_paths: [png("ok.png"), join(work.dir, "missing.png")],
      });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });

    const badVoices = [
      ["an unknown provider", { provider: "elevenlabs", voice_id: "eve" }],
      ["an unknown OpenAI voice", { provider: "openai", voice: "robot" }],
      ["an extra key", { provider: "xai", voice_id: "eve", instructions: "fast" }],
      ["an xAI voice without voice_id", { provider: "xai" }],
      ["instructions over 1000 characters", { provider: "openai", voice: "cedar", instructions: "x".repeat(1001) }],
    ];
    for (const [label, voice] of badVoices) {
      it(`refuses a voice with ${label} before calling the API`, async () => {
        const res = await ctx.call("adsoptimiser_create_character", { name: "A", job_ids: ["job_a"], voice });
        assert.equal(res.isError, true);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("passes the API's voice validation errors through", async () => {
      state.characterError = {
        status: 400,
        json: { error: "Invalid character", errors: ["default_voice_id must name the same preset as voice"] },
      };
      const res = await ctx.call("adsoptimiser_update_character", {
        character_id: "chr_amos",
        voice: { provider: "xai", voice_id: "leo" },
        default_voice_id: "rex",
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /The request was rejected: Invalid character\n- default_voice_id must name the same preset as voice/);
      assert.deepEqual(res.structured.errors, ["default_voice_id must name the same preset as voice"]);
    });

    it("explains an OpenAI voice on a deployment without OpenAI", async () => {
      state.characterError = {
        status: 400,
        json: { error: "OpenAI voices are not configured", code: "openai_voices_not_configured" },
      };
      const res = await ctx.call("adsoptimiser_create_character", {
        name: "A",
        job_ids: ["job_a"],
        voice: { provider: "openai", voice: "cedar" },
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /OpenAI voices are not available on this Ads Optimiser deployment.*"provider": "xai"/);
      assert.equal(res.structured.code, "openai_voices_not_configured");
    });
  });

  describe("voices", () => {
    it("list_voices reports both providers and the rules", async () => {
      const res = await ctx.call("adsoptimiser_list_voices");
      assert.match(res.text, /xAI preset voices: eve, leo, rex/);
      assert.match(res.text, /OpenAI voices \(gpt-4o-mini-tts\): cedar, nova/);
      assert.match(res.text, /OpenAI voices are available\./);
      assert.match(res.text, /- Talking videos speak xAI presets only\./);
      assert.deepEqual(res.structured.xai_voice_ids, ["eve", "leo", "rex"]);
      assert.deepEqual(res.structured.openai_voices, ["cedar", "nova"]);
      assert.equal(res.structured.openai_configured, true);
    });

    it("preview_voice sends { voice, text } and returns the playable URL", async () => {
      const voice = { provider: "openai", voice: "cedar", instructions: "gravelly" };
      const res = await ctx.call("adsoptimiser_preview_voice", { voice, text: "G'day from the farm" });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(bodyOf(requests("POST", "/api/v1/voices/preview")[0]), { voice, text: "G'day from the farm" });
      assert.match(res.text, /Preview of OpenAI cedar: https:\/\/api\.example\.test\/media\//);
      assert.equal(res.structured.content_type, "audio/mpeg");
      assert.equal(res.structured.path, undefined);
      assert.equal(stub.requests.length, 1, "nothing is downloaded without save_to");
    });

    it("preview_voice refuses text over 300 characters before calling the API", async () => {
      const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "eve" }, text: "x".repeat(301) });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });

    it("preview_voice maps a 503 from a deployment without OpenAI", async () => {
      state.previewError = { status: 503, json: { error: "OpenAI voices are not configured", code: "openai_voices_not_configured" } };
      const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "openai", voice: "nova" } });
      assert.equal(res.isError, true);
      assert.match(res.text, /Use an xAI preset voice instead/);
    });

    it("save_to downloads the mp3 from this deployment's media, without the token", async () => {
      const res = await ctx.call("adsoptimiser_preview_voice", {
        voice: { provider: "xai", voice_id: "leo" },
        text: "Hello there, mate!",
        save_to: "previews",
      });
      assert.equal(res.isError, false, res.text);
      const expected = join(work.dir, "previews", "voice-preview-xai-leo-hello-there-mate.mp3");
      assert.equal(res.structured.path, expected);
      assert.deepEqual(readFileSync(expected), MP3);
      assert.match(res.text, /Saved .*voice-preview-xai-leo-hello-there-mate\.mp3/);
      const media = stub.requests.find((r) => r.path.startsWith("/media/"));
      assert.equal(media.path, `/media/${encodeURIComponent(PREVIEW_KEY)}`);
      assert.equal(media.headers.authorization, undefined);
    });

    it("save_to \"\" uses the default output folder and never overwrites", async () => {
      const args = { voice: { provider: "openai", voice: "cedar" }, save_to: "" };
      const first = await ctx.call("adsoptimiser_preview_voice", args);
      const second = await ctx.call("adsoptimiser_preview_voice", args);
      assert.equal(first.isError, false, first.text);
      assert.equal(first.structured.path.startsWith(join(work.dir, "adsoptimiser-output")), true);
      assert.match(second.structured.path, /-2\.mp3$/);
      assert.match(second.text, /numbered name/);
      assert.equal(readdirSync(join(work.dir, "adsoptimiser-output")).length, 2);
    });

    for (const folder of ["../escape", "out/../../escape", "..\\escape"]) {
      it(`save_to refuses the folder ${JSON.stringify(folder)} before anything is synthesised`, async () => {
        const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "eve" }, save_to: folder });
        assert.equal(res.isError, true);
        assert.match(res.text, /contains "\.\."/);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("save_to never fetches a media_url on another host", async () => {
      state.noStorageUri = true;
      state.previewUrl = "https://evil.example.com/media/x.mp3";
      const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "eve" }, save_to: "previews" });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /Not saved locally/);
      assert.equal(res.structured.path, undefined);
      assert.equal(stub.requests.length, 1);
    });

    it("save_to accepts a media_url on this deployment when storage_uri is missing", async () => {
      state.noStorageUri = true;
      state.previewUrl = `${stub.url}/media/${encodeURIComponent(PREVIEW_KEY)}`;
      const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "eve" }, save_to: "previews" });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(readFileSync(res.structured.path), MP3);
    });
  });

  describe("character_id and script on generation", () => {
    const jobBody = () => bodyOf(requests("POST", "/api/v1/jobs")[0]);

    it("generate_image sends character_id at the top level", async () => {
      await ctx.call("adsoptimiser_generate_image", { prompt: "On the porch", character_id: "chr_amos", wait: false });
      assert.deepEqual(jobBody(), {
        asset_type: "image",
        prompt: "On the porch",
        model: "grok-imagine-image-2.0",
        generation_params: {},
        character_id: "chr_amos",
      });
    });

    it("generate_image leaves one slot for the character: at most 4 other references", async () => {
      const res = await ctx.call("adsoptimiser_generate_image", {
        prompt: "x",
        character_id: "chr_amos",
        reference_image_paths: [png("1.png"), png("2.png")],
        reference_image_urls: ["https://cdn.example.com/3.png", "https://cdn.example.com/4.png", "https://cdn.example.com/5.png"],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /With character_id at most 4 other reference images/);
      assert.equal(stub.requests.length, 0);
    });

    it("generate_video with character_id and script defaults to Grok Video 1.5 (reference-to-video)", async () => {
      const res = await ctx.call("adsoptimiser_generate_video", {
        prompt: "Amos on his porch",
        character_id: "chr_amos",
        script: "Hard work never goes out of style.",
      });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(jobBody(), {
        asset_type: "video",
        prompt: "Amos on his porch",
        model: "grok-imagine-video-1.5",
        generation_params: { aspect_ratio: "9:16" },
        character_id: "chr_amos",
        script: "Hard work never goes out of style.",
      });
    });

    it("generate_video with a character and a source image keeps the classic default model", async () => {
      await ctx.call("adsoptimiser_generate_video", { prompt: "x", character_id: "chr_amos", source_job_id: "job_img" });
      const body = jobBody();
      assert.equal(body.model, "grok-imagine-video");
      assert.equal(body.character_id, "chr_amos");
      assert.match(body.generation_params.image_url, /\/media\/images%2Fjob_img\.png$/);
    });

    it("an explicit model wins over the reference-to-video default", async () => {
      await ctx.call("adsoptimiser_generate_video", { prompt: "x", script: "Hi", model: "grok-imagine-video" });
      assert.equal(jobBody().model, "grok-imagine-video");
    });

    it("job summaries carry the voice fallback note", async () => {
      state.voiceNote = "The character's OpenAI voice cedar cannot speak in talking videos; used xAI rex.";
      const res = await ctx.call("adsoptimiser_generate_video", { prompt: "x", character_id: "chr_amos", script: "Hi" });
      assert.match(res.text, /\nVoice: The character's OpenAI voice cedar cannot speak/);
      assert.equal(res.structured.voice_note, state.voiceNote);
    });

    it("run_pipeline passes character_id, and list_pipelines flags templates that need one", async () => {
      const list = await ctx.call("adsoptimiser_list_pipelines");
      assert.equal(list.structured.templates[1].needs_character, true);
      assert.equal(list.structured.templates[0].needs_character, false);
      assert.match(list.text, /character-talking-clip: Talking clip\. c \(pass character_id to adsoptimiser_run_pipeline\)/);
      const run = await ctx.call("adsoptimiser_run_pipeline", {
        template_id: "character-talking-clip",
        character_id: "chr_amos",
        prompt: "Morning chores",
      });
      assert.equal(run.isError, false, run.text);
      assert.deepEqual(bodyOf(requests("POST", "/api/v1/pipelines")[0]), {
        template_id: "character-talking-clip",
        prompt: "Morning chores",
        character_id: "chr_amos",
      });
    });
  });
});
