# openai-image-remote-mcp

A **remote** MCP server (Streamable HTTP) that generates and edits images with **your** OpenAI
API key, hosts the results on **Vercel Blob**, and returns **public image URLs**. Built to be added
as a **custom connector on claude.ai** so cloud features (Design / Cowork, projects, web chat) can
generate real images and embed them into pages, slides, and documents.

The local stdio version (`../openai-image-mcp`) only works in desktop apps. This one works in the
cloud because Claude's servers can reach it over HTTPS.

---

## What you get

Three tools:

- `generate_image(prompt, size?, quality?, n?, model?, include_base64?)` → returns a public PNG URL (+ inline preview)
- `edit_image(image_url, prompt, mask_url?, size?, quality?, model?, include_base64?)` → edits an image by URL, returns a new URL
- `save_to_album(image_url, prompt?, source?, note?)` → saves any image URL into the GitHub photo album

Images are generated with `gpt-image-2.5-sunburst` (or `OPENAI_IMAGE_MODEL`) unless a call names another model.
When `GITHUB_TOKEN` and `GITHUB_PHOTO_REPO` are set, every generated or edited image is also committed to that repo.

Images are returned as **URLs** (not local files) so Claude can drop them straight into `<img src>`.

---

## Deploy (one time, ~10 min)

You run these — they need your Vercel + OpenAI login.

### 1. Install deps

```bash
cd open-ai-mcp
npm install
```

### 2. Log in to Vercel + link the project

```bash
npm i -g vercel      # if you don't have the CLI
vercel login
vercel link          # create a new project when prompted
```

### 3. Enable Blob storage (for hosting the images)

- Go to https://vercel.com/dashboard → your project → **Storage** → **Create** → **Blob**.
- This auto-adds `BLOB_READ_WRITE_TOKEN` to the project.

### 4. Set the env vars

Invent a long random secret (keep it OUT of this repo). Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
vercel env add OPENAI_API_KEY production
# paste your OpenAI key when prompted

vercel env add MCP_SECRET production
# paste the secret above
```

(You can also add them in the dashboard: Project → Settings → Environment Variables.)

### 5. Deploy

```bash
vercel deploy --prod
```

Note the production URL it prints, e.g. `https://openai-image-remote-mcp.vercel.app`.

---

## Your connector URL

Combine the deploy URL + `/api/mcp` + the secret:

```
https://YOUR-PROJECT.vercel.app/api/mcp?k=<YOUR_MCP_SECRET>
```

Keep this URL private — anyone who has it can spend your OpenAI credits.

---

## Add it to claude.ai

1. https://claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Paste the connector URL above.
3. Save. Claude will connect and list `generate_image`, `edit_image` and `save_to_album`.
4. In a chat / Design, say: *"use the openai-image connector to generate ..."*.

If claude.ai insists on OAuth and refuses the URL, tell Claude Code — the code is structured so an
OAuth layer can be added; that's the fallback.

---

## Test before wiring it up

Use the MCP inspector against your deployed URL:

```bash
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP
# url: https://YOUR-PROJECT.vercel.app/api/mcp?k=<secret>
```

You should see the three tools and be able to call `generate_image`.

---

## Local dev (optional)

```bash
cp .env.example .env.local   # fill in OPENAI_API_KEY, MCP_SECRET, BLOB_READ_WRITE_TOKEN
npm run dev
# endpoint: http://localhost:3000/api/mcp?k=<secret>
```

---

## Cost

Same as the OpenAI image API: roughly $0.005 (low/mini) up to ~$0.21 (flagship/high) per image.
Tell Claude "use low quality" while iterating. Plus Vercel Blob storage/bandwidth (free tier is
generous). Set an OpenAI spend limit as a backstop.
