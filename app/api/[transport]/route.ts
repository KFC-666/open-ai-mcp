import { createMcpHandler } from "mcp-handler";
import { put } from "@vercel/blob";
import { z } from "zod";
import sharp from "sharp";

/**
 * Remote MCP server for image generation.
 *
 * Exposed by Vercel at:
 *   POST /api/mcp   (Streamable HTTP — this is the URL you give claude.ai)
 *   GET  /api/sse   (legacy SSE, also handled)
 *
 * Auth: every request must carry the shared secret, either as
 *   ?k=<MCP_SECRET>   query param   (this is what the connector URL uses)
 *   Authorization: Bearer <MCP_SECRET>   header
 * Missing/wrong secret -> 401. This keeps strangers from spending your OpenAI credits.
 *
 * Required env vars (set in Vercel project settings):
 *   OPENAI_API_KEY          your OpenAI key
 *   MCP_SECRET              a long random string you invent
 *   BLOB_READ_WRITE_TOKEN   auto-added when you enable Vercel Blob on the project
 * Optional:
 *   OPENAI_IMAGE_MODEL      default "gpt-image-2.5-sunburst"
 */

const API_BASE = "https://api.openai.com/v1";

// The model used unless the caller names another one. Overridable via env.
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-sunburst";

// Models a caller may name. "auto" means DEFAULT_MODEL.
const MODEL_CHOICES = ["auto", "gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-1.5"] as const;

/** DEFAULT_MODEL at every size and quality; another model only when the caller names it. */
function pickModel(model: string | undefined): string {
  return model && model !== "auto" ? model : DEFAULT_MODEL;
}

// Image generation can take a while; give the function room (seconds).
export const maxDuration = 300;

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
};

/** Pull base64 payloads out of an OpenAI images response (also handles url-style responses). */
async function extractImages(json: OpenAIImageResponse): Promise<string[]> {
  const out: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) out.push(item.b64_json);
    else if (item.url) {
      const buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
      out.push(buf.toString("base64"));
    }
  }
  if (!out.length) throw new Error("OpenAI returned no image data.");
  return out;
}

/** Upload each base64 image to Vercel Blob and return public URLs. */
async function hostImages(b64List: string[], prompt: string): Promise<string[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug =
    prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const urls: string[] = [];
  for (let i = 0; i < b64List.length; i++) {
    const name = `images/${stamp}-${slug}${b64List.length > 1 ? `-${i + 1}` : ""}.png`;
    const { url } = await put(name, Buffer.from(b64List[i], "base64"), {
      access: "public",
      contentType: "image/png",
      // BLOB_READ_WRITE_TOKEN is read from env automatically.
    });
    urls.push(url);
  }
  return urls;
}

/** GitHub album settings, or null when not configured. Names are case-sensitive; accept lowercase too. */
function albumConfig(): { token: string; repo: string; branch: string } | null {
  const token = process.env.GITHUB_TOKEN || process.env.github_token;
  const repo = process.env.GITHUB_PHOTO_REPO || process.env.github_photo_repo;
  if (!token || !repo) return null;
  const branch = process.env.GITHUB_PHOTO_BRANCH || process.env.github_photo_branch || "main";
  return { token, repo, branch };
}

/** Raw GET against the album repo's contents API (works for a private repo). */
async function albumGet(path: string, raw = true): Promise<Response> {
  const cfg = albumConfig();
  if (!cfg) throw new Error("The GitHub album is not configured on the server (GITHUB_TOKEN / GITHUB_PHOTO_REPO).");
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return fetch(`https://api.github.com/repos/${cfg.repo}/contents/${enc}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** Sniff the real image type from the first bytes. */
function sniff(buf: Buffer): { mime: string; ext: string } | null {
  const sig = buf.subarray(0, 12).toString("hex");
  if (sig.startsWith("89504e47")) return { mime: "image/png", ext: "png" };
  if (sig.startsWith("ffd8ff")) return { mime: "image/jpeg", ext: "jpg" };
  if (sig.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (sig.startsWith("47494638")) return { mime: "image/gif", ext: "gif" };
  return null;
}

/**
 * If `ref` points into the album, return its repo path ("photos/2026-11/x.png" or an id without extension).
 * Accepts: an album path, a bare file name or id ("20261122-212839-hn42[.png]"),
 * or a github.com/…/blob/… or raw.githubusercontent.com URL of the album repo.
 */
function albumPathOf(ref: string): string | null {
  const s = ref.trim().replace(/^album:/i, "");
  if (!/^https?:\/\//i.test(s)) {
    const p = s.replace(/^\/+/, "");
    if (p.startsWith("photos/")) return p;
    if (/^\d{8}-\d{6}-[a-z0-9-]+(\.\w+)?$/i.test(p)) return p; // bare id / file name
    return null;
  }
  const cfg = albumConfig();
  if (!cfg) return null;
  const u = new URL(s);
  const repo = cfg.repo.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (u.hostname === "github.com" && `${parts[0]}/${parts[1]}`.toLowerCase() === repo && ["blob", "raw"].includes(parts[2])) {
    return parts.slice(4).join("/");
  }
  if (u.hostname === "raw.githubusercontent.com" && `${parts[0]}/${parts[1]}`.toLowerCase() === repo) {
    return parts.slice(3).join("/");
  }
  return null;
}

/** "20261122-212839-hn42" or "20261122-212839-hn42.png" -> "photos/2026-11/20261122-212839-hn42.png" */
async function completeAlbumPath(p: string): Promise<string> {
  if (p.includes("/") && IMG_EXT.test(p)) return p;
  const name = p.split("/").pop()!;
  const m = name.match(/^(\d{4})(\d{2})\d{2}-/);
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : m ? `photos/${m[1]}-${m[2]}` : "";
  if (!dir) throw new Error(`Can't tell which album folder "${p}" is in. Use a path like photos/2026-11/<file>.png.`);
  if (IMG_EXT.test(name)) return `${dir}/${name}`;
  const res = await albumGet(dir, false);
  if (!res.ok) throw new Error(`Album folder ${dir} not found (GitHub ${res.status}).`);
  const list = (await res.json()) as Array<{ name: string }>;
  const hit = list.find((f) => f.name.replace(IMG_EXT, "") === name && IMG_EXT.test(f.name));
  if (!hit) throw new Error(`No photo named ${name} in ${dir}.`);
  return `${dir}/${hit.name}`;
}

type SourceImage = { buf: Buffer; mime: string; ext: string; label: string };

/** Download an image from the album (private repo, via the token) or from any public URL. */
async function loadImage(ref: string): Promise<SourceImage> {
  const albumPath = albumPathOf(ref);
  let buf: Buffer;
  let label: string;
  if (albumPath) {
    const path = await completeAlbumPath(albumPath);
    const res = await albumGet(path);
    if (!res.ok) throw new Error(`Album photo ${path} not found (GitHub ${res.status}).`);
    buf = Buffer.from(await res.arrayBuffer());
    label = `album:${path}`;
  } else {
    if (!/^https?:\/\//i.test(ref)) {
      throw new Error(`"${ref}" is neither a URL nor an album path (photos/YYYY-MM/<file>).`);
    }
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Could not download ${ref}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    label = ref;
  }
  if (buf.length > 25 * 1024 * 1024) throw new Error(`${label} is larger than 25 MB.`);
  const t = sniff(buf);
  if (!t) throw new Error(`${label} is not a PNG/JPEG/WebP image.`);
  if (t.mime === "image/gif") {
    // The image model takes PNG/JPEG/WebP only: use the GIF's first frame.
    const png = await sharp(buf, { pages: 1 }).png().toBuffer();
    return { buf: png, mime: "image/png", ext: "png", label: `${label} (first frame)` };
  }
  return { buf, ...t, label };
}

/** Small JPEG thumbnail for inline previews (full PNGs are several MB). */
async function thumbnail(buf: Buffer): Promise<string> {
  const out = await sharp(buf, { pages: 1 })
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return out.toString("base64");
}

/**
 * Optional: also keep a copy of every image in a private GitHub repo (a photo album).
 * Enabled only when both env vars are set:
 *   GITHUB_TOKEN       fine-grained token with Contents: read & write on that repo only
 *   GITHUB_PHOTO_REPO  "owner/repo", e.g. "KFC-666/zhanzhan-photos"
 *   GITHUB_PHOTO_BRANCH  optional, default "main"
 * Each call becomes ONE commit: photos/YYYY-MM/<stamp>-<id>.png plus a .json with the prompt.
 * Failures never break image generation; they only add a note to the reply.
 */
async function saveToGitHub(
  b64List: string[],
  meta: {
    prompt: string;
    model: string;
    kind: "generate" | "edit" | "save";
    urls: string[];
    size?: string;
    ext?: string; // file extension without dot, default "png"
    source?: string; // where a saved image came from, e.g. "Hugging Face Z-Image"
    note?: string;
  },
): Promise<string> {
  const cfg = albumConfig();
  if (!cfg) return "";
  const { token, repo, branch } = cfg;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status} ${json?.message ?? ""}`), { status: res.status });
    return json;
  };

  // Taiwan time for folder / file names
  const tw = new Date(Date.now() + 8 * 3600e3).toISOString(); // 2026-11-07T20:15:30.123Z (shifted)
  const month = tw.slice(0, 7);
  const stamp = tw.slice(0, 19).replace(/[-:]/g, "").replace("T", "-"); // 20261107-201530
  const time = new Date().toISOString();

  const work = async () => {
    const files: { path: string; content: string; encoding: "base64" | "utf-8" }[] = [];
    b64List.forEach((b64, i) => {
      const id = `${stamp}-${Math.random().toString(36).slice(2, 6)}${b64List.length > 1 ? `-${i + 1}` : ""}`;
      const base = `photos/${month}/${id}`;
      files.push({ path: `${base}.${meta.ext ?? "png"}`, content: b64, encoding: "base64" });
      files.push({
        path: `${base}.json`,
        content: JSON.stringify(
          {
            prompt: meta.prompt,
            model: meta.model,
            kind: meta.kind,
            size: meta.size ?? null,
            time,
            url: meta.urls[i] ?? null,
            ...(meta.source ? { source: meta.source } : {}),
            ...(meta.note ? { note: meta.note } : {}),
          },
          null,
          1,
        ),
        encoding: "utf-8",
      });
    });
    const blobs = await Promise.all(
      files.map((f) => api("POST", "git/blobs", { content: f.content, encoding: f.encoding })),
    );
    const tree = files.map((f, i) => ({ path: f.path, mode: "100644", type: "blob", sha: blobs[i].sha }));
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await api("GET", `git/ref/heads/${encodeURIComponent(branch)}`);
      const parent = ref.object.sha as string;
      const parentCommit = await api("GET", `git/commits/${parent}`);
      const newTree = await api("POST", "git/trees", { base_tree: parentCommit.tree.sha, tree });
      const commit = await api("POST", "git/commits", {
        message: `${{ edit: "改圖", save: "存圖", generate: "生圖" }[meta.kind]}：${(meta.prompt || meta.note || meta.source || "").slice(0, 60)}`,
        tree: newTree.sha,
        parents: [parent],
      });
      try {
        await api("PATCH", `git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
        return `Saved a copy to the GitHub album (${repo}/photos/${month}/).`;
      } catch (e: any) {
        if (e?.status !== 422 || attempt === 2) throw e; // 422 = someone else committed first; retry
      }
    }
    return "";
  };

  try {
    return await Promise.race([
      work(),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timed out")), 20000)),
    ]);
  } catch (e) {
    return `(Album copy to GitHub failed: ${e instanceof Error ? e.message : String(e)}. The image itself is fine.)`;
  }
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ok(urls: string[], b64List: string[], modelUsed: string, includeB64: boolean, note = "") {
  const header =
    (urls.length === 1
      ? `Image generated with ${modelUsed}. Public URL (embed in <img src> / markdown):\n${urls[0]}`
      : `Images generated with ${modelUsed}. Public URLs:\n${urls.join("\n")}`) + (note ? `\n${note}` : "");

  const content: Content[] = [
    { type: "text", text: header },
    // First image inline so the model can also see what it made.
    { type: "image", data: b64List[0], mimeType: "image/png" },
  ];

  if (includeB64) {
    // For egress-restricted sandboxes (Cowork/Design) that get a 403 fetching the
    // Blob URL: hand over the raw base64 so they can decode it to a file locally,
    // no network needed —  e.g.  echo '<b64>' | base64 -d > image.png
    content.push({
      type: "text",
      text:
        "Raw base64 PNG (decode to a file for in-sandbox compositing, no network fetch):\n" +
        b64List.map((b, i) => `--- image ${i + 1} (base64) ---\n${b}`).join("\n"),
    });
  }

  return { content };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Image request failed: ${message}` }],
    isError: true,
  };
}

const handler = createMcpHandler((server) => {
  server.tool(
    "generate_image",
    "Generate an image from a text prompt using OpenAI, host it, and return a PUBLIC URL you can embed " +
      "directly in HTML pages, slides, or markdown. The image is also saved to the user's GitHub photo album when the " +
      "server has one configured. Write a detailed prompt: subject, style, lighting, composition. " +
      `Model: ${DEFAULT_MODEL} at every size and quality. Set 'model' only when the user asks for a different one. ` +
      "Cost and generation time rise with size and quality: 1024x1024 at low or medium suits drafts, icons, thumbnails " +
      "and simple graphics; the 1536 sizes and high quality suit detailed hero or print art. High quality can take over " +
      "a minute, which some clients cut off. " +
      "If a sandbox gets a 403 fetching the returned URL, pass include_base64=true and decode the base64 to a file.",
    {
      prompt: z.string().describe("Detailed description of the image to generate."),
      size: z
        .enum(["1024x1024", "1024x1536", "1536x1024", "auto"])
        .optional()
        .describe("Square/portrait/landscape. Default to 1024x1024 unless the layout truly needs a larger/other aspect."),
      quality: z
        .enum(["low", "medium", "high", "auto"])
        .optional()
        .describe("Cost scales with quality. Use low/medium by default; only use high when detail genuinely matters."),
      n: z.number().int().min(1).max(4).optional().describe("How many variations (default 1)."),
      model: z
        .enum(MODEL_CHOICES)
        .optional()
        .describe(
          `Which OpenAI image model. Omit it or pass 'auto' to use ${DEFAULT_MODEL}. Name another model only when ` +
            "the user asks for it.",
        ),
      include_base64: z
        .boolean()
        .optional()
        .describe(
          "Also return the raw base64 PNG. Use when a sandbox can't fetch the URL (403 allowlist) and you need " +
            "the bytes to composite or edit the image locally.",
        ),
    },
    async ({ prompt, size, quality, n, model, include_base64 }) => {
      try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
        const chosen = pickModel(model);
        const body: Record<string, unknown> = { model: chosen, prompt, n: n ?? 1 };
        if (size) body.size = size;
        if (quality) body.quality = quality;

        const res = await fetch(`${API_BASE}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as OpenAIImageResponse;
        if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

        const images = await extractImages(json);
        const urls = await hostImages(images, prompt);
        const note = await saveToGitHub(images, { prompt, model: chosen, kind: "generate", urls, size });
        return ok(urls, images, chosen, !!include_base64, note);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "edit_image",
    "Edit or extend an existing image following a text instruction. Hosts the result and returns a new public URL; " +
      "the result is also saved to the user's GitHub photo album when the server has one configured. " +
      "The source can be a public URL or a photo from the user's private album: give its album path " +
      "(e.g. photos/2026-11/20261122-212839-hn42.png — find paths with list_album), its bare id, or its " +
      "github.com / raw.githubusercontent.com link; the server reads the album with its own token. " +
      "Add up to 15 more images in reference_images (same formats) to combine them or borrow a face, outfit, pet or " +
      "style; say in the prompt which image is which (the source is image 1). Optionally supply a mask: a PNG with " +
      "the same dimensions as the source whose transparent pixels mark the region to change; without a mask the " +
      "whole image may be redrawn. Model, size and quality work as in generate_image.",
    {
      image_url: z
        .string()
        .min(1)
        .describe("The source image: a public URL, or an album path / id / GitHub link of a photo in the album."),
      prompt: z.string().describe("What to change."),
      reference_images: z
        .array(z.string().min(1))
        .max(15)
        .optional()
        .describe("More images to use alongside the source (URLs or album paths), referred to as image 2, 3, …"),
      mask_url: z.string().min(1).optional().describe("Optional PNG mask (URL or album path)."),
      size: z
        .enum(["1024x1024", "1024x1536", "1536x1024", "auto"])
        .optional()
        .describe("Output size: square, portrait or landscape. Omit to let the image model choose."),
      quality: z
        .enum(["low", "medium", "high", "auto"])
        .optional()
        .describe("Cost and time rise with quality; high can take over a minute."),
      model: z
        .enum(MODEL_CHOICES)
        .optional()
        .describe(`Omit it or pass 'auto' to use ${DEFAULT_MODEL}. Name another model only when the user asks for it.`),
      include_base64: z
        .boolean()
        .optional()
        .describe("Also return raw base64 PNG (for sandboxes that get a 403 fetching the URL)."),
    },
    async ({ image_url, prompt, reference_images, mask_url, size, quality, model, include_base64 }) => {
      try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
        const chosen = pickModel(model);

        const [sources, mask] = await Promise.all([
          Promise.all([image_url, ...(reference_images ?? [])].map((r) => loadImage(r))),
          mask_url ? loadImage(mask_url) : Promise.resolve(null),
        ]);
        if (mask && mask.mime !== "image/png") throw new Error("The mask must be a PNG.");

        const form = new FormData();
        form.append("model", chosen);
        form.append("prompt", prompt);
        const field = sources.length > 1 ? "image[]" : "image";
        sources.forEach((s, i) => {
          form.append(field, new Blob([new Uint8Array(s.buf)], { type: s.mime }), `image-${i + 1}.${s.ext}`);
        });
        if (mask) form.append("mask", new Blob([new Uint8Array(mask.buf)], { type: "image/png" }), "mask.png");
        if (size) form.append("size", size);
        if (quality) form.append("quality", quality);

        const res = await fetch(`${API_BASE}/images/edits`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
        const json = (await res.json()) as OpenAIImageResponse;
        if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);

        const images = await extractImages(json);
        const urls = await hostImages(images, prompt);
        const note = await saveToGitHub(images, {
          prompt,
          model: chosen,
          kind: "edit",
          urls,
          size,
          source: sources.map((s) => s.label).join(" + "),
        });
        return ok(urls, images, chosen, !!include_base64, note);
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.tool(
    "save_to_album",
    "Save an existing image (given by a public URL — e.g. one made by another tool such as a Hugging Face Space) " +
      "into the user's private GitHub photo album. Use when the user asks to keep / save / 存 an image that was not " +
      "made by generate_image or edit_image (those are saved automatically). Accepts PNG, JPEG or WebP.",
    {
      image_url: z.string().url().describe("Public URL of the image to save."),
      prompt: z.string().optional().describe("The prompt that produced the image, if known."),
      source: z.string().optional().describe("Where the image came from, e.g. 'Hugging Face Z-Image Turbo'."),
      note: z.string().optional().describe("Optional caption."),
    },
    async ({ image_url, prompt, source, note }) => {
      try {
        if (!(process.env.GITHUB_TOKEN || process.env.github_token) || !(process.env.GITHUB_PHOTO_REPO || process.env.github_photo_repo)) {
          throw new Error("The GitHub album is not configured on the server (GITHUB_TOKEN / GITHUB_PHOTO_REPO).");
        }
        const res = await fetch(image_url);
        if (!res.ok) throw new Error(`Could not download the image: HTTP ${res.status}`);
        const type = (res.headers.get("content-type") || "").split(";")[0].trim();
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 20 * 1024 * 1024) throw new Error("Image is larger than 20 MB.");
        const sig = buf.subarray(0, 12).toString("hex");
        const ext = sig.startsWith("89504e47") ? "png"
          : sig.startsWith("ffd8ff") ? "jpg"
          : sig.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP" ? "webp"
          : type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "";
        if (!ext) throw new Error(`Not a PNG/JPEG/WebP image (content-type: ${type || "unknown"}).`);
        const note2 = await saveToGitHub([buf.toString("base64")], {
          prompt: prompt ?? "",
          model: "",
          kind: "save",
          urls: [image_url],
          ext,
          source,
          note,
        });
        if (!note2.startsWith("Saved")) throw new Error(note2 || "Save failed.");
        return { content: [{ type: "text" as const, text: note2 }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "list_album",
    "List photos in the user's private GitHub photo album, newest first, with the album groups each belongs to " +
      "and the start of the prompt that made it. Use it to find the path of a photo to pass to edit_image " +
      "(image_url / reference_images). Filter by album name (e.g. 我們, 澄澄澎澎, Q版角色), month (YYYY-MM) or a " +
      "keyword found in the prompt / caption. Set preview=true to also see small thumbnails of the first 4 listed photos.",
    {
      album: z.string().optional().describe("Album name to filter by. Omit to list everything."),
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe("Only photos from this month, YYYY-MM."),
      query: z.string().optional().describe("Keyword to look for in the prompt, caption, source or file name."),
      limit: z.number().int().min(1).max(60).optional().describe("How many to return (default 20)."),
      preview: z.boolean().optional().describe("Also return small thumbnails of the first 4 listed photos."),
    },
    async ({ album, month, query, limit, preview }) => {
      try {
        const cfg = albumConfig();
        if (!cfg) throw new Error("The GitHub album is not configured on the server (GITHUB_TOKEN / GITHUB_PHOTO_REPO).");
        const treeRes = await fetch(
          `https://api.github.com/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`,
          {
            headers: {
              Authorization: `Bearer ${cfg.token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            cache: "no-store",
          },
        );
        if (!treeRes.ok) throw new Error(`Could not read the album (GitHub ${treeRes.status}).`);
        const tree = ((await treeRes.json()) as { tree: Array<{ path: string; type: string; size?: number }> }).tree;
        const jsonPaths = new Set(tree.filter((t) => t.path.endsWith(".json")).map((t) => t.path));

        // Which named albums hold which photos (albums.json is optional).
        const groups = new Map<string, string[]>();
        const albumNames: string[] = [];
        const aRes = await albumGet("albums.json");
        if (aRes.ok) {
          const data = (await aRes.json().catch(() => ({}))) as { albums?: Array<{ name: string; photos?: string[] }> };
          for (const a of data.albums ?? []) {
            albumNames.push(a.name);
            for (const p of a.photos ?? []) groups.set(p, [...(groups.get(p) ?? []), a.name]);
          }
        }

        let items = tree
          .filter((t) => t.type === "blob" && t.path.startsWith("photos/") && IMG_EXT.test(t.path))
          .map((t) => ({ path: t.path, size: t.size ?? 0, albums: groups.get(t.path) ?? [] }))
          .sort((a, b) => b.path.split("/").pop()!.localeCompare(a.path.split("/").pop()!));

        if (album) {
          const want = album.trim().toLowerCase();
          items = items.filter((i) => i.albums.some((n) => n.toLowerCase() === want));
          if (!items.length && !albumNames.some((n) => n.toLowerCase() === want)) {
            throw new Error(`No album named "${album}". Albums: ${albumNames.join(", ") || "(none)"}.`);
          }
        }
        if (month) items = items.filter((i) => i.path.startsWith(`photos/${month}/`));

        const metaOf = async (path: string): Promise<Record<string, any> | null> => {
          const jp = path.replace(IMG_EXT, ".json");
          if (!jsonPaths.has(jp)) return null;
          const r = await albumGet(jp);
          return r.ok ? ((await r.json().catch(() => null)) as Record<string, any> | null) : null;
        };
        const fetchMeta = async (list: typeof items) => {
          const out = new Map<string, Record<string, any> | null>();
          for (let i = 0; i < list.length; i += 25) {
            const chunk = list.slice(i, i + 25);
            const metas = await Promise.all(chunk.map((it) => metaOf(it.path)));
            chunk.forEach((it, j) => out.set(it.path, metas[j]));
          }
          return out;
        };

        const max = limit ?? 20;
        let metas: Map<string, Record<string, any> | null>;
        if (query) {
          const q = query.trim().toLowerCase();
          const pool = items.slice(0, 400);
          metas = await fetchMeta(pool);
          items = pool.filter((it) => {
            const m = metas.get(it.path);
            const hay = [it.path, m?.prompt, m?.note, m?.source, ...it.albums].filter(Boolean).join(" ").toLowerCase();
            return hay.includes(q);
          });
        }
        const total = items.length;
        items = items.slice(0, max);
        if (!query) metas = await fetchMeta(items);

        const lines = items.map((it) => {
          const m = metas!.get(it.path);
          const bits = [it.path];
          if (it.albums.length) bits.push(`[${it.albums.join(", ")}]`);
          if (/\.gif$/i.test(it.path)) bits.push("(GIF — edit_image uses its first frame)");
          const text = (m?.note || m?.prompt || m?.source || "").replace(/\s+/g, " ").trim();
          if (text) bits.push(`— ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`);
          return bits.join(" ");
        });
        const head =
          `${total} photo${total === 1 ? "" : "s"} found` +
          (total > items.length ? `, showing the newest ${items.length}` : "") +
          ". Pass a path to edit_image as image_url or in reference_images." +
          (albumNames.length ? `\nAlbums: ${albumNames.join(", ")}` : "");

        const content: Content[] = [{ type: "text", text: `${head}\n\n${lines.join("\n") || "(nothing)"}` }];
        if (preview) {
          const shown = items.slice(0, 4);
          const thumbs = await Promise.all(
            shown.map((i) => loadImage(i.path).then((img) => thumbnail(img.buf)).catch(() => null)),
          );
          thumbs.forEach((data, k) => {
            if (!data) return;
            content.push({ type: "text", text: shown[k].path });
            content.push({ type: "image", data, mimeType: "image/jpeg" });
          });
        }
        return { content };
      } catch (err) {
        return fail(err);
      }
    },
  );
}, {}, {
  // The route lives at app/api/[transport]/route.ts, so it is mounted under /api.
  // mcp-handler needs to know this prefix to map /api/mcp and /api/sse correctly.
  basePath: "/api",
  maxDuration: 300,
});

/** Shared-secret gate. Accepts ?k=<secret> or Authorization: Bearer <secret>. */
function authorized(req: Request): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret) return false; // fail closed if the server is misconfigured
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("k");
  const fromHeader = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return fromQuery === secret || fromHeader === secret;
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="openai-image-mcp"' },
    });
  }
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
