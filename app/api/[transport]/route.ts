import { createMcpHandler } from "mcp-handler";
import { put } from "@vercel/blob";
import { z } from "zod";

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
 *   OPENAI_IMAGE_MODEL      default "gpt-image-1.5"
 */

const API_BASE = "https://api.openai.com/v1";

// Non-flagship default (cheaper/faster). Overridable via env.
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5";

// Bengali/Bangla script renders far better on gpt-image-2. Detect by numeric
// codepoint (U+0980–U+09FF) — no regex literal, so it survives minification.
function hasBengali(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0980 && c <= 0x09ff) return true;
  }
  return false;
}

/**
 * Intelligent model rotation.
 *  - An explicit model always wins.
 *  - Prompt contains Bengali text -> gpt-image-2 (best at that script).
 *  - "auto" + quality=high -> flagship gpt-image-2 for final renders.
 *  - Otherwise the cheaper/faster DEFAULT_MODEL (gpt-image-1.5).
 */
function pickModel(model: string | undefined, quality: string | undefined, prompt: string): string {
  if (model && model !== "auto") return model;
  if (hasBengali(prompt)) return "gpt-image-2";
  if (quality === "high") return "gpt-image-2";
  return DEFAULT_MODEL;
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
  meta: { prompt: string; model: string; kind: "generate" | "edit"; urls: string[]; size?: string },
): Promise<string> {
  // Names are case-sensitive; accept the lowercase spellings too.
  const token = process.env.GITHUB_TOKEN || process.env.github_token;
  const repo = process.env.GITHUB_PHOTO_REPO || process.env.github_photo_repo;
  if (!token || !repo) return "";
  const branch = process.env.GITHUB_PHOTO_BRANCH || process.env.github_photo_branch || "main";
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
      files.push({ path: `${base}.png`, content: b64, encoding: "base64" });
      files.push({
        path: `${base}.json`,
        content: JSON.stringify(
          { prompt: meta.prompt, model: meta.model, kind: meta.kind, size: meta.size ?? null, time, url: meta.urls[i] ?? null },
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
        message: `${meta.kind === "edit" ? "改圖" : "生圖"}：${meta.prompt.slice(0, 60)}`,
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
      "directly in HTML pages, slides, or markdown. Write a detailed prompt — subject, style, lighting, composition. " +
      "Model: leave 'auto' (gpt-image-1.5 for most work; gpt-image-2 auto-selected for Bengali text or quality=high) or set it. " +
      "gpt-image-2 handles Bengali/Bangla text well, so prefer it when the image must render Bangla words. " +
      "Match size and quality to the NEED — do NOT default to high quality or large sizes. Use 1024x1024 + low/medium for " +
      "drafts, icons, thumbnails, simple graphics; reserve high quality and 1536-wide/tall sizes for detailed hero/print art. " +
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
        .enum(["auto", "gpt-image-1.5", "gpt-image-2"])
        .optional()
        .describe(
          "Which OpenAI image model. 'auto' (default) uses gpt-image-2 when quality=high, else gpt-image-1.5. " +
            "Pick gpt-image-2 for final/hero art, gpt-image-1.5 for drafts and iteration.",
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
        const chosen = pickModel(model, quality, prompt);
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
    "Edit or extend an existing image (given by its public URL) using a text instruction, host the result, " +
      "and return a new PUBLIC URL. Optionally supply a mask URL (transparent pixels mark the region to change).",
    {
      image_url: z.string().url().describe("Public URL of the source image to edit."),
      prompt: z.string().describe("What to change."),
      mask_url: z.string().url().optional().describe("Public URL of an optional PNG mask."),
      size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional(),
      quality: z.enum(["low", "medium", "high", "auto"]).optional(),
      model: z
        .enum(["auto", "gpt-image-1.5", "gpt-image-2"])
        .optional()
        .describe("Which model. 'auto' (default): gpt-image-2 when quality=high, else gpt-image-1.5."),
      include_base64: z
        .boolean()
        .optional()
        .describe("Also return raw base64 PNG (for sandboxes that get a 403 fetching the URL)."),
    },
    async ({ image_url, prompt, mask_url, size, quality, model, include_base64 }) => {
      try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY not set on the server.");
        const chosen = pickModel(model, quality, prompt);

        const imgBuf = Buffer.from(await (await fetch(image_url)).arrayBuffer());
        const form = new FormData();
        form.append("model", chosen);
        form.append("prompt", prompt);
        form.append("image", new Blob([imgBuf], { type: "image/png" }), "image.png");
        if (mask_url) {
          const maskBuf = Buffer.from(await (await fetch(mask_url)).arrayBuffer());
          form.append("mask", new Blob([maskBuf], { type: "image/png" }), "mask.png");
        }
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
        const note = await saveToGitHub(images, { prompt, model: chosen, kind: "edit", urls, size });
        return ok(urls, images, chosen, !!include_base64, note);
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
