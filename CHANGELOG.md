# Changelog

All notable changes to `@cintelisai/adsoptimiser-mcp` are recorded here. Versions follow [semantic versioning](https://semver.org/).

## 0.11.0 (2026-09-29)

### Added

- **Cloned voices (ElevenLabs).** Voice profiles accept `{ "provider": "elevenlabs", "voice_id", "xai_voice_id"? }` for a cloned voice the workspace may use: in `adsoptimiser_lip_sync`, `adsoptimiser_preview_voice`, a character's `voice` (`adsoptimiser_create_character`, `adsoptimiser_update_character`) and a pipeline's `add_voiceover` and `lip_sync` steps. Cloned voices are scoped to their workspaces by the server. Talking videos cannot speak them and fall back to `xai_voice_id`, else eve.
- `adsoptimiser_list_voices` lists the workspace's cloned voices with the exact profile to pass, and whether they are configured (`elevenlabs_voices`, `elevenlabs_configured`).
- **Sync LipSync 2 Pro.** `adsoptimiser_lip_sync` (and the pipeline `lip_sync` step) take `model: "sync-lipsync-2-pro"` for the best mouth and teeth fidelity (about US$5 per minute; any resolution, clips up to 60 seconds). Kling stays the default.
- The lip-sync, video and server descriptions advise lip-syncing a clip where the person faces the camera with the mouth closed and still, not a clip where they are already talking.

## 0.10.0 (2026-09-28)

### Added

- **Text placement on overlays.** Each cue of `adsoptimiser_add_overlays` (and of a pipeline's `add_captions` `cues`) takes optional `y`, from 0.05 to 0.95, the vertical centre of the text as a fraction of the frame height (0 is the top), which overrides `position`; `size`, `small`, `medium` or `large` (default medium for a caption, large for a card); and `max_width`, from 0.4 to 1.0, the text block's width as a fraction of the frame width. A cue's text may hold explicit line breaks (`\n`), at most 3 lines. Auto captions take `captions_y` (0.05 to 0.95, overriding `captions_position`) and `captions_size` (`small`, `medium` or `large`).
- The `adsoptimiser_add_overlays` description now says it works on any finished video, with no need to regenerate the video or run a pipeline to caption it, advises keeping cards out of the upper third of a 9:16 talking clip, where the face is (for example `y: 0.62`, or `position: "center"`), and suggests `\n` for two short lines. The server instructions say the same.
- **The `input_video` pipeline node ("Your video (library)").** No inputs, one `video` output, free and creates no job. It takes exactly one of `video_job_id` (a ready video job in the workspace) or `video_url` (the workspace's own `/media` URL) and can feed `add_captions`, `add_voiceover`, `strip_audio`, `lip_sync` and `extend_video`. The local catalogue descriptions and graph rules cover it, and the new "Re-caption a video (your video -> captions)" template.
- Only in this package: a local .mp4 or .mov for an `input_video` node, as `params.video_path` or as a `video_url` that is not a URL, is checked and uploaded (`POST /api/v1/jobs/source-media`, source type video) and replaced with its hosted URL before the graph is validated, saved or run, as local images in `input_image` nodes already are. Each file is uploaded once per session, and a node that mixes a local file with another source is refused.
- `adsoptimiser_list_pipelines` marks templates that start from your video (`needs_video`, from the API or from an `input_video` step). `adsoptimiser_run_pipeline` takes `video_job_id`, `video_url` or a local `video_path` for a template or saved pipeline, which fills every empty `input_video` step, for example `template_id: "video-recaption"`.

### Changed

- Only in this package: every placement value (`y`, `size`, `max_width`, the line count, `captions_y` and `captions_size`) is checked on your machine before anything is uploaded, sent or charged, with every problem listed at once. The same cue checks now run on a graph's `add_captions` cues before a graph is validated, saved or run.
- On a deployment that predates these features, the reply says what it doesn't support yet instead of a bare refusal: "this Ads Optimiser deployment doesn't support cue placement (y, size and max_width) yet", caption placement (`captions_y` and `captions_size`) or line breaks in cues, when a 400 names a field this request used as unknown; and the input_video node, when graph validation or a save reports it as an unknown node type (with a pointer to `adsoptimiser_add_overlays`).

## 0.9.0 (2026-09-28)

### Added

- `adsoptimiser_add_overlays`, the same as the hosted connector's `add_overlays`: burn timed text into a finished video with `POST /api/v1/jobs/overlays`. Pass exactly one source, `video_job_id` or `video_url`, plus `cues` (at most 50, each `{ text, start, end, position?, style? }`: 1 to 200 characters, seconds from the start of the video with 0 <= start < end, position `top`, `center` or `bottom`, style `caption` or `card`) and/or `auto_captions: true`, which has the server transcribe the speech (whisper-1, about US$0.006 per minute) and add word-timed caption chunks at `captions_position` (default `bottom`). An optional `script`, the words you know are spoken, corrects the transcript's spellings. The tool description includes an example of grade cards timed to spoken moments. It is asynchronous: it returns the new job id at once, to follow with `adsoptimiser_get_job`. Rendering counts as one creative job from the plan allowance, not a generation. Only in this package: `video_path`, a local .mp4 or .mov (at most 120 MB) that is checked and uploaded for you first, as for `adsoptimiser_lip_sync`.
- Only in this package: every rule of the request is checked on your machine before anything is uploaded, sent or charged (exactly one source, at least one cue or auto captions, the cue count, each cue's text length, timing and order, and the position and style values), and every problem is listed at once.
- `adsoptimiser_get_job` and `adsoptimiser_list_jobs` describe overlay jobs (model `media-overlays`, shown as "overlay video"): the cue count, whether auto captions were added, the transcript's word count, the transcription model and cost, and the source video job, with an `overlays` object in the structured content. `adsoptimiser_get_job` also shows the start of the transcript.
- The pipeline node catalogue passes the `add_captions` node's new optional params through from the API: `timing` (`even`, or `speech` to time captions to the transcribed speech) and `cues` (timed text, the same shape as above). The local descriptions and a graph rule cover them for older catalogues, and array params now show their item fields and maximum count.

### Changed

- Clear messages for the overlays route's refusals: invalid cues (400 `invalid_cues`, with each problem the server lists), an invalid request (400 `invalid_request`), a source not found (404), not ready (409) or not a video (415), transcription not configured (503 `transcription_not_configured`; pass timed cues instead) and transcription failed (502 `transcription_failed`). On a deployment that predates overlays (403 `token_scope_denied`, or 404 because the route does not exist) the reply says this Ads Optimiser deployment doesn't support overlays yet. A bare 404 with `video_job_id` is told apart by looking the job up.

## 0.8.0 (2026-09-28)

### Added

- **OpenAI GPT Image 2.5 models**, the same as the hosted connector: `adsoptimiser_generate_image` takes `gpt-image-2.5-sunburst` (precise: follows detailed specs such as exact colours, counts, character sheets and thumbnail layouts closely) and `gpt-image-2.5-flare` (fast) where the deployment offers them (see `adsoptimiser_list_models`). `quality` gains `high`, for the OpenAI models only (they take low, medium, high or auto and default to medium). They take `aspect_ratio` 1:1, 2:3, 9:16, 3:2, 16:9 or auto (9:16 is delivered as 2:3 at 1024x1536, 16:9 as 3:2 at 1536x1024), no `resolution`, and up to 5 reference images. `adsoptimiser_batch_generate` passes the same `model` and `quality` through.
- **Grok to OpenAI fallback in job summaries.** When Grok fails upstream (5xx or a timeout) the deployment retries an image once on GPT Image 2.5 Sunburst. `adsoptimiser_get_job` (and `adsoptimiser_generate_image`) then say so, as the connector does: "Generated with GPT Image 2.5 Sunburst after Grok failed (500)." for a ready job, or "Grok timed out; retried once on GPT Image 2.5 Sunburst." for a failed one, with `fallback_note` and `fallback` (`from`, `to`, `reason`) in the structured content. The job's `model` is the model that actually made the image.
- Only in this package: a job made by OpenAI shows its provider cost ("Provider cost: US$0.0114 (openai).", with `provider_cost_usd` and `provider` in the structured content), and `adsoptimiser_list_jobs` marks jobs made by the fallback.
- The pipeline node catalogue passes the new `generate_image` model and quality values through from the API, the local descriptions cover them for older catalogues, and a graph rule explains the OpenAI models and the fallback.

### Changed

- Only in this package: image options the API is known to refuse are checked before anything is sent or charged, in `adsoptimiser_generate_image` and `adsoptimiser_batch_generate`: an aspect ratio GPT Image 2.5 cannot deliver (the message suggests 9:16, delivered as 2:3), a `resolution` on an OpenAI model, `quality` high on a Grok model, and `quality` on `grok-imagine-image` or a Luma model. A model this package does not know is left for the API to judge.
- Clear messages for the new API refusals: OpenAI image models not configured on the deployment (503 `openai_images_not_configured`; nothing is charged, use a Grok model), an unknown image model (now a 400; the reply points to `adsoptimiser_list_models`), and an aspect ratio refused for an OpenAI model (with the "9:16 is delivered as 2:3" hint).

## 0.7.0 (2026-09-28)

### Added

- `adsoptimiser_view_image`, the same as the hosted connector's `view_image`: one image at a larger size so Claude can check detail (colours, small features, text, the views on a character sheet). Pass exactly one of `job_id`, `key`, or `character_id` with `image_index` (1 to 5); optionally `size` (768, 1024 or 1536 px, default 1024; images are never upscaled) and `crop`, a region `{ x, y, width, height }` given as fractions of the original image (each from 0 to 1, width and height at least 0.05, and x + width and y + height at most 1), applied before scaling so it is a real zoom. The crop is checked locally before anything is sent. The reply is one text block (the source, the returned size, the original size, the crop and a hint on using crop) followed by one `image` block, and the structured content carries `source`, `width`, `height`, `original_width`, `original_height`, `crop`, `size` and `mime_type`. It uses `GET /api/v1/media/thumbnail` and uses no allowance.
- A character's reference image is found the same way `adsoptimiser_get_character` previews it: by its key when it is stored on this Ads Optimiser deployment, else by the job it came from. An image hosted elsewhere with no job is named as an external URL and never fetched.
- One image may be at most 2,000,000 base64 bytes. A larger one is fetched once more at the next smaller size, and the reply says so; if it is still too large, the reply says it was not attached and suggests a crop.
- Only in this package: `save_to`, a local folder where the returned image is also saved, named `view-<job id, key or character and index>-<width>x<height>` (with `-crop` for a crop). Existing files are never replaced (a numbered name is used instead), and folder paths containing `..` are refused before anything is fetched.

### Changed

- Clear messages when an image can't be viewed: not found, a job not finished yet, not an image, a refused crop, a video with no poster frame, or a deployment that can't resize images right now. On a deployment that predates `adsoptimiser_view_image` (it refuses the larger sizes, refuses the route to tokens, or has no such route) the reply says the deployment doesn't support view_image yet and that previews in other tools are 384px.

## 0.6.0 (2026-09-28)

### Added

- **Claude can now see what was generated.** Tools attach small preview images to their results, the same as the hosted connector: `include_thumbnails` on `adsoptimiser_get_job`, `adsoptimiser_generate_image` and `adsoptimiser_get_character` (on by default) and on `adsoptimiser_list_jobs` and `adsoptimiser_list_character_assets` (off by default). Previews come from the API's `GET /api/v1/media/thumbnail` at 384 px, at most 1 per job, 5 reference images per character and 6 per list. Each image is at most 600,000 base64 bytes and a result carries at most 1,500,000 in total; anything over is left out and named. The images follow the text as `image` blocks, after a line naming them in order ("Attached N preview image(s) ... in order: ...") and a line listing what was not previewed and why ("Not previewed: ..."). The structured content is unchanged.
- Videos are previewed only when a poster frame is stored; otherwise the reply says so. A character's reference images on another host are not previewed ("external URL"), and nothing is fetched from another host.

### Changed

- A preview that fails (not ready, not found, no poster frame, a scaling failure, a timeout) becomes a note in the text, never a tool error. Only in this package: on a deployment that predates previews (the route answers 403 `token_scope_denied`, or 404 because it does not exist) the reply says once that the deployment doesn't serve previews yet, instead of naming each image.
- The API client has a binary request helper for previews. Like every other API call, it sends the token to the Ads Optimiser API host only.

## 0.5.0 (2026-09-28)

### Added

- `adsoptimiser_list_character_assets`, the same as the hosted connector's `list_character_assets`: everything made with a saved character, newest first (images, videos, talking clips, lip-syncs, voiceovers and captioned clips), with result URLs, the kept speech audio (`speech_url`), the line spoken (`script`), the voice and the pipeline run. Takes `character_id` and optionally `type` (`image`, `video`, `talking`, `lip_sync`, `voiceover` or `captions`), `cursor` (the `next_cursor` of the previous page) and `limit` (1 to 50, default 10), and reports counts per kind. Only in this package: `download_to`, a local folder where the listed finished files are saved (images, videos and the speech mp3s kept with lip-syncs and voiceovers), at most 20 files per call. Files are fetched only from this Ads Optimiser deployment's media, never with the token, are named `<job id>-<script or prompt words>` (`<job id>-speech-...mp3` for speech), and never replace an existing file. Folder paths containing `..` are refused before anything is called. Files over the cap are listed by job so a smaller page can pick them up.
- `adsoptimiser_get_character` now also summarises what was made with the character, as the connector does: counts per kind, the latest 5 items and the latest 3 voice previews. Only in this package: an `audio` list gathers the kept speech and voice preview URLs, and the reply says how to save them locally (speech with `download_to`, a preview with `adsoptimiser_preview_voice` and `save_to`).
- `adsoptimiser_preview_voice` takes an optional `character_id` to file the preview in that character's voice preview history (shown on its page in the app), and returns the `preview_id`.

### Changed

- On a deployment without the Characters hub, `adsoptimiser_get_character` still returns the character (the summary is left out), and `adsoptimiser_list_character_assets` says the deployment predates the hub instead of reporting the character as not found.

## 0.4.0 (2026-09-27)

### Added

- `adsoptimiser_lip_sync`, the same as the hosted connector's `lip_sync`: make the person in a finished clip say a new line in a designed voice (an OpenAI voice with instructions, or an xAI preset; by default the character's own voice), with the mouth re-animated to match by Kling LipSync. Takes `video_job_id` or `video_url`, `script` (at most 900 characters), and optionally `voice`, `character_id` and `model` (`kling-lipsync`, the only model). It is asynchronous: it returns the job id and estimated provider cost at once, so follow it with `adsoptimiser_get_job`. Each lip-sync uses one video generation from the plan allowance and counts toward the daily video quota. Only in this package: `video_path`, a local .mp4 or .mov clip (at most 100 MB) that is checked and uploaded for you. Pass exactly one of `video_job_id`, `video_url` or `video_path`.
- Clear messages for the lip-sync refusals: lip-sync not configured, a source clip Kling cannot use (it needs 2 to 10 seconds at 720p or 1080p), speech that does not fit the clip, speech synthesis failures, a source video that is not ready yet, and a deployment that does not yet allow lip-sync for API tokens.
- Job summaries label lip-sync jobs ("lip-sync video", model "Kling LipSync") and show the voice used, where it came from, the length of the speech and the source job.
- The pipeline node catalogue's local descriptions and graph rules cover the `lip_sync` node (inputs video and script; params script, voice, voice_id and model) and the `character-lip-sync` template, "Character talking clip (designed voice)". A graph whose `lip_sync` node has no script and nothing wired into its script input needs a run prompt.

### Changed

- The graph rules now point talking clips in an OpenAI voice to `lip_sync` instead of `strip_audio` then `add_voiceover`.

### Fixed

- A file of the wrong kind now reads "is an image, but a video is needed" instead of "is a image, but an video is needed".

## 0.3.0 (2026-09-27)

### Added

- Character and voice tools, the same as the hosted connector's:
  - `adsoptimiser_list_characters` and `adsoptimiser_get_character`: saved characters (consistent AI people such as influencers or brand ambassadors) with their reference images, description, style and voice.
  - `adsoptimiser_create_character` and `adsoptimiser_update_character`: save a character from 1 to 5 images, with an optional voice (`{ provider: "xai", voice_id }` or `{ provider: "openai", voice, instructions?, xai_voice_id? }`, or the `default_voice_id` shorthand; `null` clears it). As well as `image_urls` and `job_ids`, both accept `image_paths`: local images that are checked and uploaded for you, 5 images in total across all three. Characters cannot be deleted with a token; delete them in the app.
  - `adsoptimiser_list_voices`: xAI preset voices and OpenAI gpt-4o-mini-tts voices, and whether OpenAI voices are configured.
  - `adsoptimiser_preview_voice`: a short sample (at most 300 characters) in any voice, with no job and no allowance. Only in this package: `save_to` also saves the mp3 to a local folder so you can play it, with the same folder checks and no-overwrite naming as `adsoptimiser_download_job`.
- `character_id` on `adsoptimiser_generate_image`, `adsoptimiser_generate_video` and `adsoptimiser_run_pipeline`, and `script` (the exact words spoken to camera) on `adsoptimiser_generate_video`. A character or script with no source image defaults to Grok Video 1.5, which serves reference-to-video. With `character_id`, `adsoptimiser_generate_image` takes at most 4 other reference images.
- Job summaries include a `Voice:` note when a talking video could not speak a character's OpenAI voice and fell back to an xAI preset.
- `adsoptimiser_list_pipelines` marks templates that need a `character_id`.
- The node catalogue from `adsoptimiser_get_pipeline_nodes` carries the new `character` and `add_captions` nodes and the add_voiceover `voice` param with its accepted shapes, and the graph rules explain characters, captions and voice precedence.
- Clearer errors: a rejected request lists the API's validation errors, and an OpenAI voice on a deployment without OpenAI says to use an xAI preset instead.

### Fixed

- `adsoptimiser_get_pipeline_nodes` read the catalogue's params as an object, but current deployments send an array, so params were listed by position instead of by name. Both shapes now work, and the local descriptions only fill in what the API leaves out.

## 0.2.0 (2026-09-27)

### Fixed

- **Starts in time in Claude Desktop on Windows.** 0.1.0 depended on the MCP SDK, whose ~90 dependency packages `npx` resolved and installed on every launch. That took over 30 seconds, longer than Claude Desktop's start-up limit, so the server was dropped before it answered. The package is now a single self-contained file, `dist/server.mjs`, bundled with esbuild: installing it adds one package and nothing else, and in testing it answered `tools/list` in about a tenth of a second.

### Added

- Pipeline builder tools, the same as the hosted connector's:
  - `adsoptimiser_get_pipeline_nodes`: the node catalogue (inputs, outputs, params with allowed values and ranges, rules), the graph rules and a worked example.
  - `adsoptimiser_get_pipeline`: a saved pipeline's graph, node count and estimated cost per run.
  - `adsoptimiser_validate_pipeline`: errors by node id, node count, estimated cost per run and whether a run prompt is needed. Uses no allowance.
  - `adsoptimiser_save_pipeline`: save a new pipeline (`POST /pipelines/graphs`) or update one by `graph_id` (`PATCH /pipelines/graphs/:graph_id`), with a link to the pipeline editor.
- `adsoptimiser_run_pipeline` accepts an inline `graph` as well as `template_id` or `graph_id` (exactly one). Inline graphs are validated first and not run if invalid, and the reply gives the step count and estimated cost.
- Local image paths in `input_image` nodes (`image_url` or `image_path`) are checked, uploaded and replaced with their hosted URL before a graph is validated, saved or run. Each file is uploaded once per session.
- A clear message when the Ads Optimiser deployment does not yet allow pipeline building with API tokens.
- README: Windows and Claude Desktop troubleshooting, including running a global install with `node` instead of `npx`.
- `dist/THIRD-PARTY-NOTICES.txt` with the licences of the bundled packages.

### Changed

- The `bin` is now `dist/server.mjs`. `@modelcontextprotocol/sdk` and `zod` are build-time dependencies only.
- CI tests Node 18.17, 18, 20 and 22 (and 22 on Windows), and installs the packed tarball on its own to check it starts with no other packages.

## 0.1.0 (2026-09-27)

First release.

- Device-flow sign-in (`adsoptimiser_connect`, `adsoptimiser_finish_connect`), with a generate-only, workspace-scoped token cached per host in the home directory; `adsoptimiser_status` and `adsoptimiser_disconnect`.
- The hosted connector's generate tools: list models, enhance a prompt, generate images and videos, get and list jobs, list and run pipelines, get a pipeline run.
- Local file tools: `adsoptimiser_upload_file`, local reference and source images for generation, `adsoptimiser_download_job` and `adsoptimiser_batch_generate`.
