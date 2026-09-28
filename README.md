# Ads Optimiser MCP server

Connects Claude (Desktop, Code, or any MCP client) to [Ads Optimiser](https://adsoptimiser.com.au) so you can generate TikTok ad images and videos from a chat, using files on your own computer.

**Sign-in is SSO, not keys.** The first connection starts an OAuth device flow (RFC 8628): Claude shows you a URL and a short code, you approve in a browser where you are already signed in to Ads Optimiser, and a workspace-scoped token is delivered back automatically. Nothing is typed, pasted, or stored in any config file.

## Setup

Requires Node.js 18.17 or later. The package is a single self-contained file with no dependencies, so `npx` has one small download to make and starts in well under Claude Desktop's start-up limit.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config), then restart Claude Desktop from the system tray:

```json
{
  "mcpServers": {
    "adsoptimiser": {
      "command": "npx",
      "args": ["-y", "@cintelisai/adsoptimiser-mcp@latest"]
    }
  }
}
```

On Windows, if `npx` fails to launch, use `"command": "cmd", "args": ["/c", "npx", "-y", "@cintelisai/adsoptimiser-mcp@latest"]`.

#### Troubleshooting on Windows

If Ads Optimiser does not appear in Claude Desktop, or shows as failed:

1. Check the server log at `%LOCALAPPDATA%\Claude\Logs\mcp-server-adsoptimiser.log`. The Microsoft Store version of Claude Desktop logs there; other installs log to `%APPDATA%\Claude\logs`. Claude Desktop gives a server about 30 seconds to answer, so a log that ends with the transport closing shortly after `initialize` means the server started too slowly.
2. Version 0.2.0 and later start in well under a second once downloaded. If you are on an older version, `@latest` in the config picks up the fix on the next restart.
3. To take `npx` out of the picture entirely, install the package once and point Claude Desktop at it with `node`:

   ```
   npm install -g @cintelisai/adsoptimiser-mcp
   npm root -g
   ```

   `npm root -g` prints the global folder, for example `C:\Users\you\AppData\Roaming\npm\node_modules`. Then use:

   ```json
   {
     "mcpServers": {
       "adsoptimiser": {
         "command": "node",
         "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@cintelisai\\adsoptimiser-mcp\\dist\\server.mjs"]
       }
     }
   }
   ```

   A global install does not update itself: run `npm install -g @cintelisai/adsoptimiser-mcp` again to upgrade.

### Claude Code

```
claude mcp add adsoptimiser -- npx -y @cintelisai/adsoptimiser-mcp@latest
```

The `@latest` tag makes `npx` check for updates on each launch, so you never stay stuck on an old cached copy.

## Connecting

In any chat: *"connect to Ads Optimiser"*. Claude will call `adsoptimiser_connect` and give you a URL and code.

1. Open the URL and sign in to Ads Optimiser if asked.
2. **Check the code on the page matches** the one Claude showed you. If it does not, do not approve.
3. **Choose the workspace** this connection should use, then approve. The token only works in that workspace; to use another one later, disconnect and connect again. You need to be a member (not a viewer) of the workspace.
4. Tell Claude you've approved; it calls `adsoptimiser_finish_connect` and you're connected.

## Tools

| Tool | What it does |
| --- | --- |
| `adsoptimiser_connect` | Start the SSO device flow |
| `adsoptimiser_finish_connect` | Collect the token after you approve |
| `adsoptimiser_status` | Show the connected user, workspace and role |
| `adsoptimiser_disconnect` | Revoke the token on the server and delete it from this machine |
| `adsoptimiser_list_models` | List image and video models, their options and indicative cost |
| `adsoptimiser_enhance_prompt` | Expand a rough idea into a detailed ad prompt (uses no allowance) |
| `adsoptimiser_generate_image` | Generate an image, with a preview of the result; accepts local reference images (`reference_image_paths`), URLs, earlier jobs or a saved `character_id` |
| `adsoptimiser_generate_video` | Start a video; text-to-video, or image-to-video from a local image (`source_image_path`), URL or earlier job; `character_id` and `script` for talking clips |
| `adsoptimiser_lip_sync` | Make the person in a finished clip (a job, a URL or a local `video_path`) say a new line in a designed voice, lip-synced by Kling |
| `adsoptimiser_add_overlays` | Burn timed text cards or captions into any finished video (a job, a URL or a local `video_path`), or captions timed to the speech with `auto_captions`; place text with `y`, `size` and `max_width` |
| `adsoptimiser_get_job` | Status and result URL of one job, with a preview once it is finished |
| `adsoptimiser_list_jobs` | Recent jobs, filterable by status and type; previews with `include_thumbnails` |
| `adsoptimiser_list_pipelines` | Pipeline templates and saved pipelines |
| `adsoptimiser_get_pipeline_nodes` | The pipeline node catalogue: node types, inputs, outputs, params, graph rules and an example |
| `adsoptimiser_get_pipeline` | A saved pipeline's graph, node count and estimated cost per run |
| `adsoptimiser_validate_pipeline` | Check a pipeline graph: errors by node, node count, estimated cost, whether it needs a prompt (uses no allowance) |
| `adsoptimiser_save_pipeline` | Save a pipeline graph to the workspace, or update a saved one by `graph_id`, and link to the pipeline editor |
| `adsoptimiser_run_pipeline` | Start a pipeline run from a template, a saved pipeline or an inline graph, optionally with a `character_id` |
| `adsoptimiser_get_pipeline_run` | Status and results of each pipeline step |
| `adsoptimiser_list_characters` | Saved characters with their images, description, style and voice |
| `adsoptimiser_get_character` | One character with every reference image (previewed) and the job it came from, plus counts of what was made with it, the latest items and the latest voice previews |
| `adsoptimiser_list_character_assets` | Everything made with a character, filterable by type and paged; previews with `include_thumbnails`; with `download_to` the finished files and speech mp3s are saved locally |
| `adsoptimiser_view_image` | One image (a job, a media key or a character's reference image) at 768, 1024 or 1536 px, optionally cropped to zoom into a region, for checking detail; with `save_to` it is also saved locally |
| `adsoptimiser_create_character` | Save a character from 1 to 5 images: local files (`image_paths`), URLs or finished jobs, with an optional voice (uses no allowance) |
| `adsoptimiser_update_character` | Change a character's name, description, style, voice or images (uses no allowance) |
| `adsoptimiser_list_voices` | xAI preset voices and OpenAI voices, and whether OpenAI voices are available |
| `adsoptimiser_preview_voice` | A short sample in any voice as a playable URL, optionally filed in a character's preview history, and with `save_to` an mp3 saved locally (uses no allowance) |
| `adsoptimiser_upload_file` | Upload a local image or video and get its hosted URL (uses no allowance) |
| `adsoptimiser_download_job` | Save a finished job's image or video to a local folder |
| `adsoptimiser_batch_generate` | One job per image in a folder (image-to-video or image edit) or per line of a prompts file, up to 10 per call |

Every generation uses your workspace's monthly plan allowance, exactly as in the app. When the allowance runs out, the tools say so and link to **Billing** (`https://app.adsoptimiser.com.au/#/billing`) where you can upgrade. Videos also count toward a daily video quota.

### Image models

`adsoptimiser_generate_image` (and `adsoptimiser_batch_generate`, and a pipeline's `generate_image` step) takes a `model`. `adsoptimiser_list_models` shows what your deployment offers, with sizes and indicative cost.

| Model | Id | Good for | Options |
| --- | --- | --- | --- |
| Grok Image 2.0 (default) | `grok-imagine-image-2.0` | General ad images | `quality` low (fastest, about 13s), medium or auto (45 to 50s); `resolution` 1k or 2k; wide ratios such as 21:9 |
| Grok Image | `grok-imagine-image` | The fastest Grok images | No `quality` |
| GPT Image 2.5 Sunburst (precise, fast) | `gpt-image-2.5-sunburst` | Detailed specs followed exactly, in about 12 seconds | `quality` low, medium (default), high or auto |
| GPT Image 2.5 Flare (fast) | `gpt-image-2.5-flare` | Quick drafts in about 9 seconds, less precise on detail | `quality` low, medium (default), high or auto |

**When to pick Sunburst:** when the image has to match a detailed brief. For example exact colours ("four buttons: green, teal, amber, coral"), exact counts of objects, a character sheet (the same person from set angles, a full-body shot and a close-up), or a thumbnail with layout constraints (a title in the top third, the face on the right, room left for a logo). Grok suits open-ended scenes; Sunburst is the one to use when the details matter.

The GPT Image 2.5 models are OpenAI models, offered only where the deployment has an OpenAI key (otherwise the tools say so and suggest a Grok model). They take `aspect_ratio` 1:1 (1024x1024), 2:3 or 9:16 (both delivered at 1024x1536), 3:2 or 16:9 (both delivered at 1536x1024), or auto. Any other ratio, and any `resolution`, is refused on your machine before anything is sent, as is `quality` high on a Grok model. Up to 5 reference images work with them, the same as Grok, as does `character_id`. A finished job made by OpenAI shows its provider cost (about US$0.011 at medium quality). Each image uses one image generation from the plan allowance, whichever model makes it.

**Automatic fallback.** When Grok fails upstream (a 5xx error or a timeout) the deployment retries the image once on GPT Image 2.5 Sunburst, with the same prompt and references. It never retries a refused request or a moderation block, and the retry still counts as one generation. The job's `model` is then the model that made the image, and `adsoptimiser_get_job` says what happened, for example "Generated with GPT Image 2.5 Sunburst after Grok failed (500)", or for a job that failed both ways "Grok timed out; retried once on GPT Image 2.5 Sunburst". `adsoptimiser_list_jobs` marks these jobs too.

### Previews: Claude can see the images

Tools attach small preview images (384 px) to their results, so Claude can look at what was generated instead of working from URLs alone: check a new image, pick the best shots of a character sheet, or compare recent results. The `include_thumbnails` flag controls this per call:

| Tool | Previews | Default |
| --- | --- | --- |
| `adsoptimiser_generate_image` | the finished image, when it is ready in time | on |
| `adsoptimiser_get_job` | the finished image, or a video's poster frame | on |
| `adsoptimiser_get_character` | up to 5 reference images | on |
| `adsoptimiser_list_jobs` | up to 6 finished jobs | off |
| `adsoptimiser_list_character_assets` | up to 6 finished images on the page | off |

To keep results small, each preview is at most 600,000 bytes (base64) and one result carries at most 1,500,000 bytes of images; anything over is left out and named in the reply. Videos are previewed only when a poster frame is stored. Reference images hosted elsewhere are not previewed. A preview that fails never fails the tool: the reply says what was not previewed and why. On an Ads Optimiser deployment that predates previews, the reply says the deployment doesn't serve previews yet. Previews use no allowance.

To check detail (colours, small features, text, the views on a character sheet), ask Claude to look closer: `adsoptimiser_view_image` returns one image at 768, 1024 or 1536 px (default 1024), and its `crop` zooms into a region given as fractions of the original, for example `{ x: 0.3, y: 0.5, width: 0.4, height: 0.3 }`. Each image is at most 2,000,000 bytes (base64); a larger one is fetched again one size smaller. For characters, separate images per view show far more detail than one sheet holding many views. On an older deployment it says view_image isn't supported yet.

Claude Code limits how large a tool result may be (the `MAX_MCP_OUTPUT_TOKENS` setting). If a result with several previews is cut off or refused, ask Claude to call the tool with `include_thumbnails` set to `false`, or raise that limit.

### Building pipelines

A pipeline is a small graph of steps (up to 12 nodes): for example refine a prompt, generate an image, then animate it into a video. Ask Claude to design one, for example *"build a pipeline that turns my product photo into three 9:16 videos with different voices"*. Claude reads the node catalogue with `adsoptimiser_get_pipeline_nodes`, checks its graph with `adsoptimiser_validate_pipeline` (which reports problems by node, the estimated cost per run and whether a prompt is needed), then saves it with `adsoptimiser_save_pipeline` or runs it directly with `adsoptimiser_run_pipeline`. Saved pipelines open in the app's pipeline editor at `https://app.adsoptimiser.com.au/#/pipeline-editor`.

Where a graph needs one of your own images (an `input_image` node), give its local path as the node's `image_url` (or `image_path`). The file is checked and uploaded, and the hosted URL is put in its place before the graph is validated, saved or run.

A pipeline can also start from a video you already have, with an `input_video` node ("Your video (library)"). It has no inputs and one `video` output, is free and creates no job, and takes exactly one of `video_job_id` (a ready video job in the workspace) or `video_url` (the workspace's own `/media` URL). With this package you can also give a local .mp4 or .mov, as `video_path` or as a `video_url` that is a file path: it is checked and uploaded the same way. Wire its video into `add_captions`, `add_voiceover`, `strip_audio`, `lip_sync` or `extend_video`. The "Re-caption a video (your video -> captions)" template is this pair: `input_video` then `add_captions`. `adsoptimiser_list_pipelines` marks templates that start from your video; run them with `adsoptimiser_run_pipeline` and `video_job_id`, `video_url` or a local `video_path`, for example `template_id: "video-recaption"`. To caption a single finished video, `adsoptimiser_add_overlays` is simpler. On an older deployment the pipeline tools say it doesn't support the input_video node yet.

Validating and saving use no allowance. Running does: each generation step uses allowance like a single job. Pipeline building needs an Ads Optimiser deployment that allows it for API tokens; on an older one these tools say so and templates and saved pipelines still run.

### Characters and voices

A character is a saved person (an AI influencer, a brand ambassador) that keeps the same face across images and videos. A typical influencer workflow:

1. **Generate a character sheet.** Ask for the same person from several angles, a full-body shot and a close-up, on a neutral white background with realistic, unretouched skin.
2. **Save the best shots as a character** with `adsoptimiser_create_character`: finished jobs (`job_ids`), URLs, or your own photos (`image_paths`, checked and uploaded for you), 5 images at most. Add a description (age, face, hair, build, persona) and a voice.
3. **Preview the voice.** `adsoptimiser_list_voices` lists the xAI presets and the OpenAI voices; `adsoptimiser_preview_voice` plays a short sample, and with `save_to` saves the mp3 so you can listen locally. OpenAI voices take instructions such as accent, pacing and tone.
4. **Make content.** Pass `character_id` to `adsoptimiser_generate_image` for new scenes (porch, kitchen, garden), to `adsoptimiser_generate_video` with a `script` for a 9:16 talking-to-camera clip, or to a pipeline. For captioned b-roll, animate a scene image and add text with `adsoptimiser_add_overlays` or an `add_captions` step in a pipeline.

Talking clips in a designed voice now work through lip-sync. There are two ways:

- **One go:** run the "Character talking clip (designed voice)" template (`character-lip-sync`) with `adsoptimiser_run_pipeline`, a `character_id`, and the exact line as the prompt (about 20 words). It places the character in a fitting scene, animates an 8 second 720p clip, lip-syncs your line in the character's own voice (OpenAI or xAI) and adds captions. That is about US$0.72 per run in provider costs.
- **Step by step:** make a 2 to 10 second clip at 720p or 1080p (not 480p) with `adsoptimiser_generate_video`, then call `adsoptimiser_lip_sync` with its job id (or a URL, or a local .mp4 or .mov up to 100 MB as `video_path`) and the `script`. The line must fit the clip: speech runs about 15 characters a second, so about 20 words for an 8 second clip. The voice is `voice`, else the character's voice, else eve.

Each lip-sync uses one video generation from the plan allowance and counts toward the daily video quota. It takes 2 to 5 minutes; follow it with `adsoptimiser_get_job`.

**Everything made with a character** is gathered on its page in the app's **Characters** section: images, videos, talking clips, lip-syncs, voiceovers and captioned clips, the lines it has spoken and its voice previews. From Claude, `adsoptimiser_get_character` gives the counts per kind, the latest items and the latest voice previews, and `adsoptimiser_list_character_assets` lists the whole gallery, filtered by `type` and paged with `cursor`. Ask for *"save everything Amos has made to my Desktop"* and Claude passes `download_to`: the finished images and videos, and the speech mp3 kept with each lip-sync and voiceover, are saved to that folder, up to 20 files per call, without replacing existing files. Pass `character_id` to `adsoptimiser_preview_voice` to keep a preview in that character's history; to save a preview locally, preview the same voice and text again with `save_to` (a repeat is served from cache). On an older Ads Optimiser deployment without the Characters hub, `adsoptimiser_get_character` still returns the character and `adsoptimiser_list_character_assets` says the hub is not available.

`adsoptimiser_generate_video` with a `script` still speaks only xAI preset voices: a character with an OpenAI voice uses its `xai_voice_id` (else eve) there, and the job's `Voice:` note says so. OpenAI voices also narrate: an `add_voiceover` step speaks over a finished video in the character's voice. Characters are edited with `adsoptimiser_update_character` and deleted only in the app. Saving characters and previewing voices use no allowance.

### Overlays and captions

`adsoptimiser_add_overlays` burns text into any finished video (a video job, an https URL, or a local .mp4 or .mov as `video_path`, uploaded for you). It works on a video you already have: there is no need to regenerate it or run a pipeline to caption or re-caption it. There are two kinds of text, and one request can use both:

- **Timed cards and captions (`cues`).** Each cue is `{ text, start, end, position?, style?, y?, size?, max_width? }`: up to 200 characters shown from `start` to `end` seconds, at the `top`, `center` or `bottom`, as a `caption` line or a bold `card`. Up to 50 cues. Use these for points timed to spoken moments, for example a grade card for each subject as the presenter names it.
- **Auto captions (`auto_captions: true`).** The server transcribes the speech and captions every word as it is said, in short chunks (`captions_position`, default `bottom`). If you know the script, pass it as `script`: it corrects the transcript's spellings of names, brands and numbers.

**Placing the text.** Three optional fields fine-tune where a cue sits and how big it is:

- `y`, from 0.05 to 0.95: the vertical centre of the text as a fraction of the frame height (0 is the top). It overrides `position`.
- `size`: `small`, `medium` or `large` (default `medium` for a caption, `large` for a card).
- `max_width`, from 0.4 to 1.0: the width of the text block as a fraction of the frame width.

A cue's text may also hold line breaks (`\n`), at most 3 lines. For auto captions, `captions_y` (0.05 to 0.95, overriding `captions_position`) and `captions_size` (`small`, `medium` or `large`) do the same.

In a 9:16 talking clip the face is usually in the upper third, so keep cards below it. A face-safe grade card, on two short lines, sitting just below the middle of the frame:

```json
{ "text": "Maths\nA+", "start": 2, "end": 4.5, "style": "card", "y": 0.62, "size": "large", "max_width": 0.7 }
```

`position: "center"` is a simpler face-safe choice when you don't need the exact height.

The request is checked on your machine first (one source, at least one cue or auto captions, text lengths and line counts, timings and every placement value), so a bad one fails before anything is sent or charged. Rendering counts as one creative job from the plan allowance, not a generation; transcription for auto captions costs about US$0.006 per minute of video. The tool returns a job id at once; follow it with `adsoptimiser_get_job`, which reports the cues, whether captions were added, the transcript's word count and the transcription cost. In a pipeline, the `add_captions` step takes the same `cues` (placement fields included, checked on your machine first) and a `timing` of `speech` for captions timed to the words. On an older Ads Optimiser deployment the tool says overlays aren't supported yet, and one that predates placement says it doesn't support cue placement, caption placement or line breaks yet.

### Working with local files

- **Use absolute paths.** Claude Desktop starts servers in its own folder, so relative paths may not point where you expect. Paths starting with `~` expand to your home folder.
- **Uploads:** images must be PNG, JPEG, WebP or GIF, up to 10 MB (HEIC and TIFF need converting to JPEG or PNG first). Videos must be MP4 or MOV, up to 120 MB (100 MB for a lip-sync `video_path`). Files are checked on your machine before anything is sent.
- **Downloads** go to `./adsoptimiser-output` by default (or your home folder's `adsoptimiser-output` when the server was started in a system folder). Files are named `<job id>-<prompt words>.<ext>`. An existing file is never replaced unless you ask for `overwrite`; a numbered name such as `-2` is used instead. Folder paths containing `..` are refused.
- **Batches** stop at the first plan limit, daily quota or rate limit and report which jobs were queued and the `offset` to resume from once you are ready. The API allows about 8 generation requests a minute per person, so a full batch of 10 may need a second call.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `ADSOPTIMISER_URL` | `https://api.adsoptimiser.com.au` | The Ads Optimiser API to talk to |
| `ADSOPTIMISER_APP_URL` | `https://app.adsoptimiser.com.au` | The web app used in links (Billing, job pages) |
| `ADSOPTIMISER_OUTPUT_DIR` | `./adsoptimiser-output` | Default folder for `adsoptimiser_download_job` |

Set them in the MCP config entry, for example to target another deployment or choose where downloads land:

```json
"adsoptimiser": {
  "command": "npx",
  "args": ["-y", "@cintelisai/adsoptimiser-mcp@latest"],
  "env": {
    "ADSOPTIMISER_URL": "https://your-deployment.example.com",
    "ADSOPTIMISER_OUTPUT_DIR": "/Users/you/Documents/Ad creatives"
  }
}
```

## Hosted connector or this package?

Ads Optimiser also has a hosted connector at `https://mcp.adsoptimiser.com.au/mcp`. Add it in claude.ai under Settings > Connectors > Add custom connector, and it works in Claude on the web, mobile and desktop with nothing to install. It has the same generate tools, but it runs in the cloud, so it cannot read or write files on your computer.

Use **this package** when you want Claude to work with local files: upload product shots from a folder, turn a folder of images into videos, run a list of prompts from a file, or save finished creatives to disk. You can use both; they are separate connections, each with its own token.

## Security notes

- The token is cached in one file per host in your home folder (`~/.adsoptimiser-mcp-<host>.json`, mode 0600). On Windows the mode is not enforced; the file inherits your user profile's permissions, which by default only you and administrators can read. The token never appears in any config file, log or chat, and tools never return it.
- The token is **generate-only**: it can generate and view creatives, pipelines and characters in the one workspace you chose, save characters, preview voices and upload source media. The API refuses it for publishing, scheduling, ads and campaigns, deleting, billing, workspace settings and admin.
- Tokens are per machine and individually revocable: each appears in the app under **Profile > API tokens**, where you can revoke it. `adsoptimiser_disconnect` revokes it on the server and deletes the local copy. If a token is revoked elsewhere, the next tool call deletes the local copy and asks you to reconnect; if you lose access to the workspace, the tools tell you to reconnect to another one.
- Uploaded files are stored by Ads Optimiser under unguessable URLs so the generation models can read them. Do not upload anything you would not put in an ad.
- Media downloads fetch the public media URL directly; the token is not sent with them.
- Previews and `adsoptimiser_view_image` images are fetched from the Ads Optimiser API (`/api/v1/media/thumbnail`) with the token, like every other API call. Nothing is fetched from another host, and the token is only ever sent to the API host.

## Releasing

Publishing is automated by `.github/workflows/publish.yml`, which runs the tests and publishes to npm with provenance when a version tag is pushed.

1. Add the release to `CHANGELOG.md`, then bump the version: `npm version patch` (or `minor` / `major`), which updates `package.json` and creates a `vX.Y.Z` commit and tag. Or edit `package.json`, commit, and run `git tag vX.Y.Z`.
2. Push the commit and the tag: `git push && git push origin vX.Y.Z`.

The workflow fails if the tag does not match `package.json`, and skips publishing (with a notice) if that version is already on npm, so re-running a tag is safe. It needs an `NPM_TOKEN` repository secret: a granular npm automation token with publish rights on the `@cintelisai` scope.

## Development

```
npm install
npm test
```

The published bin is `dist/server.mjs`, a single ES module bundled by esbuild (`npm run build`, `scripts/build.mjs`) with the MCP SDK and zod inside it, so the package has no runtime dependencies. `npm test` builds it first; `npm pack` and `npm publish` rebuild it. The licences of the bundled packages ship in `dist/THIRD-PARTY-NOTICES.txt`.

- `npm start` runs the unbundled source (`server.mjs`); `npm run start:dist` runs the bundle.
- `npm run smoke` starts the bundle over stdio and times `initialize` and `tools/list`.

Tests use `node --test` against a local stub of the API; they need no network access or account. The bundle tests copy `dist/server.mjs` into an empty folder and drive it over stdio, to prove it runs with no `node_modules`.

## Licence

MIT © Cintelis Pty Limited
