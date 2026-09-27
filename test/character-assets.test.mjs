// Characters hub: get_character's summary (counts, latest items, latest voice
// previews) with its fallback on older deployments, list_character_assets and
// its local download_to extra, and character_id on preview_voice.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHARACTER_DOWNLOADS, TOOL_ROUTES } from "../src/server.mjs";
import { TOKEN, startClient, startStub, tempDir } from "./helpers.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const MP4 = Buffer.from("fake mp4 bytes");
const MP3 = Buffer.from("ID3 fake speech");

const AMOS = {
  character_id: "chr_amos",
  name: "Amos",
  description: "101-year-old farmer",
  image_urls: ["https://api.example.test/media/a.png"],
  images: [{ url: "https://api.example.test/media/a.png", job_id: "job_a" }],
  voice: { provider: "openai", voice: "cedar", instructions: "slow and warm", xai_voice_id: "rex" },
  default_voice_id: "rex",
};

const COUNTS = { image: 3, video: 0, talking: 1, lip_sync: 1, voiceover: 0, captions: 0, total: 5, last_used_at: "2026-09-28T00:00:00Z" };

/** Hub items whose URLs point at the stub (this deployment's /media route). */
function hubItems(origin) {
  const media = (key) => `${origin}/media/${encodeURIComponent(key)}`;
  return [
    {
      job_id: "job_lip",
      kind: "lip_sync",
      asset_type: "video",
      status: "ready",
      model: "kling-lipsync",
      prompt: "porch scene",
      media_url: media("videos/job_lip.mp4"),
      thumbnail_url: null,
      speech_url: media("speech/job_lip.mp3"),
      script: "G'day, I'm Amos",
      voice: AMOS.voice,
      pipeline_run_id: "run_1",
      created_at: "2026-09-28T00:00:03Z",
    },
    {
      job_id: "job_img",
      kind: "image",
      asset_type: "image",
      status: "ready",
      model: "grok-imagine-image",
      prompt: "Amos on the porch at dawn",
      media_url: media("images/job_img.png"),
      thumbnail_url: null,
      speech_url: null,
      script: null,
      voice: null,
      pipeline_run_id: null,
      created_at: "2026-09-28T00:00:02Z",
    },
    {
      job_id: "job_talk",
      kind: "talking",
      asset_type: "video",
      status: "generating",
      model: "grok-imagine-video-1.5",
      prompt: "talking clip",
      media_url: null,
      thumbnail_url: null,
      speech_url: null,
      script: "Morning all",
      voice: { provider: "xai", voice_id: "rex" },
      pipeline_run_id: null,
      created_at: "2026-09-28T00:00:01Z",
    },
  ];
}

const PREVIEWS = (origin) => [
  {
    preview_id: "vp_1",
    character_id: "chr_amos",
    voice: AMOS.voice,
    text: "Hello from the farm",
    storage_uri: "voice-previews/vp1.mp3",
    media_url: `${origin}/media/${encodeURIComponent("voice-previews/vp1.mp3")}`,
    content_type: "audio/mpeg",
    created_at: "2026-09-28T00:00:00Z",
  },
];

function makeApi(state, origin) {
  return (r) => {
    const route = `${r.method} ${r.path}`;
    if (route === "GET /api/v1/characters/chr_amos") return { json: AMOS };
    if (route === "GET /api/v1/characters/chr_amos/assets") {
      if (state.assetsError) return state.assetsError;
      const items = state.items ?? hubItems(origin);
      const limit = Number(r.url.searchParams.get("limit") ?? 24);
      return {
        json: {
          character_id: "chr_amos",
          items: items.slice(0, limit),
          counts: COUNTS,
          next_cursor: state.nextCursor ?? null,
        },
      };
    }
    if (route === "GET /api/v1/characters/chr_amos/voice-previews") {
      if (state.previewsError) return state.previewsError;
      return { json: { character_id: "chr_amos", previews: PREVIEWS(origin), next_cursor: null } };
    }
    if (route === "POST /api/v1/voices/preview") {
      const body = JSON.parse(r.body.toString());
      return {
        json: {
          media_url: `${origin}/media/${encodeURIComponent("voice-previews/vp1.mp3")}`,
          storage_uri: "voice-previews/vp1.mp3",
          content_type: "audio/mpeg",
          voice: body.voice,
          text: body.text ?? "Hi there",
          cached: true,
          preview_id: body.character_id ? "vp_1" : null,
          character_id: body.character_id ?? null,
        },
      };
    }
    if (r.method === "GET" && r.path.startsWith("/media/")) {
      if (state.mediaStatus) return { status: state.mediaStatus, body: "" };
      const key = decodeURIComponent(r.path.slice("/media/".length));
      if (key.endsWith(".mp4")) return { headers: { "content-type": "video/mp4" }, body: MP4 };
      if (key.endsWith(".mp3")) return { headers: { "content-type": "audio/mpeg" }, body: MP3 };
      return { headers: { "content-type": "image/png" }, body: PNG };
    }
    return undefined;
  };
}

function routeOf(r) {
  const path = r.path
    .replace(/^\/api\/v1\/characters\/[^/]+(\/assets|\/voice-previews)?$/, "/api/v1/characters/:character_id$1")
    .replace(/^\/media\/[^/]+$/, "/media/:key");
  return `${r.method} ${path}`;
}

describe("characters hub", () => {
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
    stub.setHandler(makeApi(state, stub.url));
    work = tempDir("adsopt-hub-");
    ctx = await startClient(stub.url, { cwd: work.dir });
    ctx.connectToken();
  });
  afterEach(async () => {
    await ctx.close();
    work.cleanup();
    stub.requests.length = 0;
  });

  const mediaRequests = () => stub.requests.filter((r) => r.path.startsWith("/media/"));

  const calls = [
    ["adsoptimiser_get_character", { character_id: "chr_amos" }],
    ["adsoptimiser_list_character_assets", { character_id: "chr_amos" }],
    ["adsoptimiser_list_character_assets", { character_id: "chr_amos", download_to: "out" }],
  ];
  for (const [name, args] of calls) {
    it(`${name} ${JSON.stringify(args)} calls only its documented routes`, async () => {
      const res = await ctx.call(name, args);
      assert.equal(res.isError, false, res.text);
      for (const r of stub.requests) {
        assert.ok(TOOL_ROUTES[name].includes(routeOf(r)), `${name} called ${routeOf(r)}`);
        const media = r.path.startsWith("/media/");
        assert.equal(r.headers.authorization, media ? undefined : `Bearer ${TOKEN}`);
      }
      assert.ok(!res.text.includes(TOKEN));
    });
  }

  describe("get_character", () => {
    it("adds counts, the latest 5 items and the latest 3 voice previews", async () => {
      const res = await ctx.call("adsoptimiser_get_character", { character_id: "chr_amos" });
      assert.equal(res.isError, false, res.text);
      const assets = stub.requests.find((r) => r.path === "/api/v1/characters/chr_amos/assets");
      assert.equal(assets.url.searchParams.get("limit"), "5");
      const previews = stub.requests.find((r) => r.path === "/api/v1/characters/chr_amos/voice-previews");
      assert.equal(previews.url.searchParams.get("limit"), "3");
      assert.deepEqual(res.structured.counts, COUNTS);
      assert.equal(res.structured.latest_items.length, 3);
      assert.equal(res.structured.latest_items[0].app_url, "https://app.example.test/#/jobs/job_lip");
      assert.equal(res.structured.latest_voice_previews[0].preview_id, "vp_1");
      assert.match(res.text, /Made with this character: 3 image, 1 talking, 1 lip_sync\./);
      assert.match(res.text, /- job_lip lip_sync ready .*videos%2Fjob_lip\.mp4 \(speech .*speech%2Fjob_lip\.mp3\) says "G'day, I'm Amos"/);
      assert.match(res.text, /Latest voice previews:\n- .*vp1\.mp3 "Hello from the farm"/);
    });

    it("lists the kept speech and voice preview URLs, and how to save them", async () => {
      const res = await ctx.call("adsoptimiser_get_character", { character_id: "chr_amos" });
      assert.deepEqual(
        res.structured.audio.map((a) => [a.source, a.job_id ?? a.preview_id]),
        [
          ["speech", "job_lip"],
          ["voice_preview", "vp_1"],
        ]
      );
      assert.match(res.structured.audio[0].url, /speech%2Fjob_lip\.mp3$/);
      assert.equal(res.structured.audio[1].text, "Hello from the farm");
      assert.match(res.text, /download_to/);
      assert.match(res.text, /save_to/);
      assert.equal(mediaRequests().length, 0, "get_character downloads nothing");
    });

    for (const [label, error] of [
      ["404", { status: 404, json: { error: "Not found" } }],
      ["403 token_scope_denied", { status: 403, json: { error: "Not for tokens", code: "token_scope_denied" } }],
      ["500", { status: 500, json: { error: "boom" } }],
    ]) {
      it(`still answers when the hub routes return ${label} (older deployment)`, async () => {
        state.assetsError = error;
        state.previewsError = error;
        const res = await ctx.call("adsoptimiser_get_character", { character_id: "chr_amos" });
        assert.equal(res.isError, false, res.text);
        assert.equal(res.structured.character_id, "chr_amos");
        assert.equal(res.structured.counts, null);
        assert.deepEqual(res.structured.latest_items, []);
        assert.deepEqual(res.structured.latest_voice_previews, []);
        assert.deepEqual(res.structured.audio, []);
        assert.match(res.text, /Character chr_amos: Amos/);
        assert.doesNotMatch(res.text, /Made with this character/);
      });
    }

    it("a missing character is still an error", async () => {
      const res = await ctx.call("adsoptimiser_get_character", { character_id: "chr_gone" });
      assert.equal(res.isError, true);
      assert.match(res.text, /Not found/);
    });
  });

  describe("list_character_assets", () => {
    it("passes type, cursor and limit, and reports the next cursor", async () => {
      state.nextCursor = "c_older";
      const res = await ctx.call("adsoptimiser_list_character_assets", {
        character_id: "chr_amos",
        type: "lip_sync",
        cursor: "c_1",
        limit: 2,
      });
      assert.equal(res.isError, false, res.text);
      const q = stub.requests[0].url.searchParams;
      assert.equal(q.get("type"), "lip_sync");
      assert.equal(q.get("cursor"), "c_1");
      assert.equal(q.get("limit"), "2");
      assert.equal(res.structured.items.length, 2);
      assert.equal(res.structured.next_cursor, "c_older");
      assert.match(res.text, /Showing 2 lip_sync item\(s\):/);
      assert.match(res.text, /More: call again with cursor c_older/);
      assert.equal(res.structured.downloads, undefined);
      assert.equal(mediaRequests().length, 0, "nothing is downloaded without download_to");
    });

    it("defaults to 10 items", async () => {
      await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos" });
      assert.equal(stub.requests[0].url.searchParams.get("limit"), "10");
    });

    it("says when a page is empty", async () => {
      state.items = [];
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos", type: "captions" });
      assert.match(res.text, /No captions items\./);
    });

    for (const [label, args] of [
      ["an unknown type", { character_id: "chr_amos", type: "audio" }],
      ["a limit over 50", { character_id: "chr_amos", limit: 51 }],
      ["a character id that could form a path", { character_id: "../x" }],
    ]) {
      it(`refuses ${label} before calling the API`, async () => {
        const res = await ctx.call("adsoptimiser_list_character_assets", args);
        assert.equal(res.isError, true);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("explains a deployment that predates the Characters hub (404 for a known character)", async () => {
      state.assetsError = { status: 404, json: { error: "Not found" } };
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos" });
      assert.equal(res.isError, true);
      assert.match(res.text, /predates the Characters hub/);
      assert.match(res.text, /adsoptimiser_get_character still works/);
    });

    it("a 404 for an unknown character stays a not-found error", async () => {
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_gone" });
      assert.equal(res.isError, true);
      assert.match(res.text, /Not found/);
      assert.doesNotMatch(res.text, /predates/);
    });

    it("explains a deployment that refuses the route to tokens (403 token_scope_denied)", async () => {
      state.assetsError = { status: 403, json: { error: "Not for tokens", code: "token_scope_denied" } };
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos" });
      assert.equal(res.isError, true);
      assert.match(res.text, /does not list character assets for API tokens yet/);
    });
  });

  describe("list_character_assets download_to", () => {
    it("saves finished media and kept speech, without the token, and reports the paths", async () => {
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos", download_to: "amos" });
      assert.equal(res.isError, false, res.text);
      const folder = join(work.dir, "amos");
      const saved = res.structured.downloads.saved;
      assert.deepEqual(
        saved.map((s) => [s.job_id, s.file]),
        [
          ["job_lip", "media"],
          ["job_lip", "speech"],
          ["job_img", "media"],
        ]
      );
      assert.equal(saved[0].path, join(folder, "job_lip-g-day-i-m-amos.mp4"));
      assert.equal(saved[1].path, join(folder, "job_lip-speech-g-day-i-m-amos.mp3"));
      assert.equal(saved[2].path, join(folder, "job_img-amos-on-the-porch-at-dawn.png"));
      assert.deepEqual(readFileSync(saved[0].path), MP4);
      assert.deepEqual(readFileSync(saved[1].path), MP3);
      assert.deepEqual(readFileSync(saved[2].path), PNG);
      assert.equal(readdirSync(folder).length, 3, "the unfinished job is not downloaded");
      for (const r of mediaRequests()) assert.equal(r.headers.authorization, undefined);
      assert.match(res.text, /Saved 3 file\(s\) in /);
      assert.ok(res.text.includes(saved[1].path));
    });

    it("\"\" uses the default output folder and never overwrites", async () => {
      const args = { character_id: "chr_amos", type: "image", download_to: "" };
      state.items = hubItems(stub.url).filter((i) => i.kind === "image");
      const first = await ctx.call("adsoptimiser_list_character_assets", args);
      const second = await ctx.call("adsoptimiser_list_character_assets", args);
      const folder = join(work.dir, "adsoptimiser-output");
      assert.equal(first.structured.downloads.saved[0].path, join(folder, "job_img-amos-on-the-porch-at-dawn.png"));
      assert.equal(second.structured.downloads.saved[0].path, join(folder, "job_img-amos-on-the-porch-at-dawn-2.png"));
      assert.equal(second.structured.downloads.saved[0].renamed, true);
      assert.match(second.text, /numbered name/);
      assert.equal(readdirSync(folder).length, 2);
    });

    for (const folder of ["../escape", "out/../../escape", "..\\escape"]) {
      it(`refuses the folder ${JSON.stringify(folder)} before calling the API`, async () => {
        const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos", download_to: folder });
        assert.equal(res.isError, true);
        assert.match(res.text, /contains "\.\."/);
        assert.equal(stub.requests.length, 0);
      });
    }

    it("never fetches media or speech on another host", async () => {
      state.items = [
        { ...hubItems(stub.url)[0], media_url: "https://evil.example.com/media/x.mp4", speech_url: "https://evil.example.com/media/s.mp3" },
        { ...hubItems(stub.url)[1], media_url: `${stub.url}/not-media/x.png` },
      ];
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos", download_to: "out" });
      assert.equal(res.isError, false, res.text);
      assert.equal(mediaRequests().length, 0);
      assert.equal(stub.requests.length, 1);
      assert.equal(res.structured.downloads.saved.length, 0);
      assert.equal(res.structured.downloads.skipped.length, 3);
      assert.match(res.text, /not saved: job_lip media \(not this deployment's media\)/);
      assert.equal(existsSync(join(work.dir, "out")), false);
    });

    it(`saves at most ${MAX_CHARACTER_DOWNLOADS} files per call and names the rest`, async () => {
      const template = hubItems(stub.url)[0];
      state.items = Array.from({ length: 12 }, (_, i) => ({
        ...template,
        job_id: `job_${String(i).padStart(2, "0")}`,
        media_url: `${stub.url}/media/${encodeURIComponent(`videos/job_${i}.mp4`)}`,
        speech_url: `${stub.url}/media/${encodeURIComponent(`speech/job_${i}.mp3`)}`,
      }));
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos", limit: 12, download_to: "out" });
      assert.equal(res.isError, false, res.text);
      const d = res.structured.downloads;
      assert.equal(d.saved.length, MAX_CHARACTER_DOWNLOADS);
      assert.equal(mediaRequests().length, MAX_CHARACTER_DOWNLOADS);
      assert.equal(d.not_attempted.length, 24 - MAX_CHARACTER_DOWNLOADS);
      assert.equal(readdirSync(join(work.dir, "out")).length, MAX_CHARACTER_DOWNLOADS);
      assert.match(res.text, /4 more file\(s\) not saved \(at most 20 per call\): job_10, job_11\./);
      assert.match(res.text, /limit 10 always fits/);
    });

    it("reports a failed download and carries on", async () => {
      state.mediaStatus = 410;
      const res = await ctx.call("adsoptimiser_list_character_assets", { character_id: "chr_amos", download_to: "out" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.structured.downloads.failed.length, 3);
      assert.match(res.text, /failed: job_lip speech: /);
      const out = join(work.dir, "out");
      assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0, "no partial files are kept");
    });
  });

  describe("preview_voice character_id", () => {
    it("sends character_id and returns the preview id", async () => {
      const voice = { provider: "openai", voice: "cedar", instructions: "slow and warm" };
      const res = await ctx.call("adsoptimiser_preview_voice", { voice, text: "Hello from the farm", character_id: "chr_amos" });
      assert.equal(res.isError, false, res.text);
      const body = JSON.parse(stub.requests[0].body.toString());
      assert.deepEqual(body, { voice, text: "Hello from the farm", character_id: "chr_amos" });
      assert.equal(res.structured.preview_id, "vp_1");
      assert.equal(res.structured.character_id, "chr_amos");
    });

    it("omits character_id when not given", async () => {
      const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "eve" } });
      assert.equal(res.isError, false, res.text);
      assert.equal("character_id" in JSON.parse(stub.requests[0].body.toString()), false);
      assert.equal(res.structured.character_id, null);
    });

    it("refuses a character id that could form a path", async () => {
      const res = await ctx.call("adsoptimiser_preview_voice", { voice: { provider: "xai", voice_id: "eve" }, character_id: "a/b" });
      assert.equal(res.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  });
});
