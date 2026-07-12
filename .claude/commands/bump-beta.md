---
description: Publish an UNOFFICIAL dev/beta build (commit to beta, push → dev-image.yml → dev images + dev chart)
argument-hint: "[note]  (optional short note added to the commit subject)"
allowed-tools: Bash, Read
---

Publish an **unofficial dev/beta build** of the current unreleased work — for testing on a server (e.g. via
ArgoCD) WITHOUT cutting an official release. This does **NOT** bump the version, does **NOT** touch the
CHANGELOG version, and does **NOT** tag. It commits the working tree to the `beta` branch and pushes, which
triggers the `dev-image.yml` workflow (dev images + a `<next>-dev-<sha>` Helm chart; no `:latest`, no release).
Do the steps below **in order**.

1. **Do NOT modify** `charts/kravn/Chart.yaml` or the CHANGELOG version — dev builds are not versioned releases.

2. **Ensure the `beta` branch.** If already on `beta`, stay. Else `git checkout beta` if it exists, otherwise
   `git checkout -b beta`. Keep `main` clean — `beta` is the dev/staging branch.

3. **Guard (MANDATORY).** `git add -A`, then
   `git diff --cached --name-only | grep -iE "\.sqlite|(^|/)data/"`. If it matches ANYTHING, **abort**
   (`git reset`) and tell the user. Never commit `data/` or `*.sqlite`.

4. **Commit on beta.** If there is anything to commit, `git commit` with subject
   `dev: <short summary of the batch>` (append ` — $ARGUMENTS` when a note was given), a body listing what's in
   this dev batch, and the trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
   If the tree is already clean (nothing new), skip the commit and just re-push to re-trigger the build.

5. **Push.** `git push -u origin beta`. This triggers `dev-image.yml`.

6. **Compute + report the artifacts.** The dev chart version = **`<next patch of Chart.yaml version>-dev-<short
   sha of the beta HEAD>`** (e.g. Chart.yaml `0.1.86` + commit `b3193f6` → `0.1.87-dev-b3193f6`). Report:
   - images `ghcr.io/<owner>/kravn:dev-<sha>` and `ghcr.io/<owner>/kravn-client:dev-<sha>`
   - dev chart `oci://ghcr.io/<owner>/charts/kravn` version `<next>-dev-<sha>`
   - the exact ArgoCD line to set: `targetRevision: <next>-dev-<sha>` (no image overrides needed — the dev
     chart's `appVersion` already points at the dev images).

7. **Verify.** `gh run list --workflow=dev-image.yml --limit 2` to confirm the run started.

Remind the user: `main` stays untouched; this is a `-dev-` pre-release (no `:latest`, no CHANGELOG, no official
version, doesn't match `0.1.*` semver ranges); on first publish a new GHCR package (`kravn-client`, or a new
chart version) may be **private** and needs to be made pullable by ArgoCD/the cluster.
