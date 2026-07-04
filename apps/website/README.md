# @kravn/website

The Kravn corporate site + product documentation. Built with [VitePress](https://vitepress.dev) and
deployed to **GitHub Pages** by `.github/workflows/website.yml`.

## Develop

```bash
pnpm --filter @kravn/website dev       # http://localhost:5173
```

## Build & preview

```bash
pnpm --filter @kravn/website build     # → apps/website/.vitepress/dist
pnpm --filter @kravn/website preview
```

## Structure

```
apps/website/
  index.md              # landing page (hero + features)
  guide/                # documentation
    what-is-kravn.md    # overview / why
    concepts.md         # core concepts
    getting-started.md  # quickstart
    installation.md     # installation manual
    configuration.md    # env + in-app config
    plugins.md          # plugins & integrations
    security.md         # security & compliance
  public/               # logo.svg, favicon.svg (served from the site root)
  .vitepress/
    config.ts           # site config, nav, sidebar
    theme/              # brand skin (custom.css)
```

## Deployment notes

- Served at `https://addlayerio.github.io/kravn/`, so the VitePress `base` is `/kravn/`.
- For a **custom domain**: add a `CNAME` file to `public/`, set `base: '/'` in `.vitepress/config.ts`,
  and update the favicon hrefs in `head`.
- One-time: repo → **Settings → Pages → Source = GitHub Actions**.
