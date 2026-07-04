# Website SEO & OpenGraph rules

**Read this before changing the site's title, meta description, `og:*` tags, or the social image.**
Everything below is enforced in `.vitepress/config.ts` (unless noted). These constraints came from a
meta-tag inspector pass — respect them so previews and search snippets don't truncate or look broken.

## Character limits

| Field | Where it's set | Target | Why |
|---|---|---|---|
| Home `<title>` | `transformPageData` home override (`slug === ''`) — sets `pageData.title` + `titleTemplate = false` | **50–60 chars** | Uses the full SERP width; too short wastes it |
| Sub-page `<title>` | page's h1 / frontmatter `title` + the `:title · Kravn` template | keep the page name short | the template appends `· Kravn` |
| Meta `description` | `description:` in config | **≤ 160 chars** (aim 150–160) | Google truncates snippets around ~160 |
| `og:description` | head `og:description` meta | **≤ 125 chars** | social previews truncate ~125 on mobile |
| `og:title` | head `og:title` meta | concise (≈ 34 chars) | — |

> ⚠️ **The meta `description` and `og:description` are TWO DIFFERENT strings** with different limits
> (~160 vs ~125). Keep both; don't point one at the other. When asked to "change the description",
> update the SEO `description` and check whether `og:description` also needs a (shorter) edit.

## Social image — `og:image` / `twitter:image`

- Must be a **PNG, 1200×630** — most social scrapers (LinkedIn, X, Slack, Facebook) do **not** render SVG.
- Served at `public/og.png`, referenced absolutely as `${HOSTNAME}/og.png?v=N`.
- Should include a **call-to-action** (currently a "Get started →" pill) — inspectors flag images without one.
- **Cache-busting:** scrapers (opengraph.xyz, LinkedIn, X, Slack, Facebook) cache the image **by URL**. When
  the image *content* changes but the path stays `og.png`, they keep serving the OLD render. So **bump the
  `?v=N`** on `og:image`/`twitter:image` in config every time you regenerate `og.png`. (Platforms also offer
  a manual re-scrape — e.g. the Facebook Sharing Debugger — but bumping `?v=N` fixes them all at once.)
- **Regenerate it** from the committed source `apps/website/og-source.svg` (no rasterizer ships in the repo):
  ```bash
  # in a scratch dir — @resvg/resvg-js is a throwaway tool, do NOT add it to the project
  npm i @resvg/resvg-js
  node -e '
    const { Resvg } = require("@resvg/resvg-js"); const fs = require("fs");
    const r = new Resvg(fs.readFileSync("apps/website/og-source.svg"),
      { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true } });
    fs.writeFileSync("apps/website/public/og.png", r.render().asPng());
  '
  ```
  (Text uses `DejaVu Sans` so it renders with `loadSystemFonts`.)

## Domain / canonical / structured data

- **`HOSTNAME`** const in config drives, in one place: the sitemap hostname, per-page `canonical` + `og:url`
  (via `transformPageData`), the JSON-LD `url`, and the `og:image` URL. **If the domain changes, change only
  `HOSTNAME`.**
- `public/CNAME` = `kravn.ai` pins the apex custom domain on every Pages deploy; `base` is `'/'`.
- `public/robots.txt` allows all + links the sitemap.
- JSON-LD (`SoftwareApplication` + `Organization`) lives in head — keep its `name`/`description`/`url`
  consistent with the meta tags.

## Quick checklist when editing title / description / image

- [ ] Meta `description` ≤ 160 chars
- [ ] `og:description` ≤ 125 chars (remember: separate string)
- [ ] Home `<title>` 50–60 chars, descriptive
- [ ] `og.png` is a PNG, 1200×630, with a CTA (regenerated from `og-source.svg`)
- [ ] Absolute URLs come from `HOSTNAME`
- [ ] Re-validate with a meta-tag inspector (e.g. opengraph.xyz) after deploy
