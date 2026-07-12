---
description: Cut an OFFICIAL Kravn release (bump version + changelog, commit to main, tag, push → release.yml)
argument-hint: "[version]  (optional, e.g. 0.1.87 — default: increment the patch)"
allowed-tools: Bash, Read, Edit
---

Cut an **official** Kravn release. This bumps the version, finalizes the changelog, commits to `main`, tags,
and pushes — which triggers the `release.yml` workflow (official image `:X.Y.Z` + `:latest` + client image +
Helm chart, all cosign-signed). Do the steps below **in order**; stop and report if a precondition fails.

Requested version: **$ARGUMENTS** — if empty, read `version:` from `charts/kravn/Chart.yaml` and increment
the **patch** (e.g. `0.1.86` → `0.1.87`). Call it `NEW_VERSION`.

1. **Preflight.**
   - `git branch --show-current` — MUST be `main` (official releases go on main). If not, STOP and tell the
     user to switch to `main` (dev/test builds use `/bump-beta`, not this).
   - `git status --porcelain` — the uncommitted changes are the accumulated `[Unreleased]` batch that this
     release ships; that's expected. If there is genuinely nothing to release (clean tree AND no
     `[Unreleased]` changelog entry), STOP and say so.
   - Announce `NEW_VERSION` before doing anything irreversible.

2. **Version = single source.** Set BOTH `version:` and `appVersion:` in `charts/kravn/Chart.yaml` to
   `NEW_VERSION`.

3. **CHANGELOG.md.** Rename the `## [Unreleased]` heading to `## [NEW_VERSION] — <today YYYY-MM-DD>`. If there
   is no `[Unreleased]` section, add a `## [NEW_VERSION] — <date>` section with a short, benefit-first,
   marker-tagged summary (📣 announce · 🔒 security · ⚡ perf · 🧩 integration · 🐛 fix) of what shipped.

4. **Guard (MANDATORY).** `git add -A`, then
   `git diff --cached --name-only | grep -iE "\.sqlite|(^|/)data/"`. If it matches ANYTHING, **abort**
   (`git reset`), do NOT commit, and tell the user. Never commit `data/` or `*.sqlite`.

5. **Commit on main.** `git commit` with subject `release: vNEW_VERSION`, a body summarizing the release, and
   the trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

6. **Tag.** `git tag -a vNEW_VERSION -m "vNEW_VERSION"`.

7. **Push.** `git push origin main`, then `git push origin vNEW_VERSION`. Pushing the tag triggers the release.

8. **Verify + report.** `gh run list --workflow=release.yml --limit 2` to confirm the run started. Report:
   the new version, that it's committed to `main` + tagged + pushed, and the release run id — the official
   image + chart are being published to `ghcr.io/<owner>`.
