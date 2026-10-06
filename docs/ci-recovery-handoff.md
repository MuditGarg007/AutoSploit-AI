# CI / Release recovery — handoff

**Date:** 2026-10-06
**Branch:** `main` (fixes were committed directly to `main` at the owner's request)
**HEAD at handoff:** `4ce36fd`

## Context

`main` was red on both the **CI** and **Release** workflows. This handoff captures
everything fixed so far, the blockers that remain, and exactly how to resume. The
failures were a chain: each fix uncovered the next one, because earlier runs died so
early they never reached the later steps.

## Current status at a glance

| Workflow | State | Where it stops now |
| --- | --- | --- |
| **CI** | **Green** | B1 resolved — MinIO pinned to GHCR mirror (`c0ef889`); run `37508093210` passed |
| **Release** | Red | `build-push` (control-plane) Trivy gate; `harness-build-push` GHCR push permission |

The purely mechanical workflow/config bugs are resolved. What remains needs either an
owner-side setting change, a dependency/base-image decision, or infrastructure (GKE)
that can't be validated from a laptop.

## Fixes already landed (all pushed to `main`)

In order, each verified by the next run advancing past the point it previously died:

1. **`efb0e6a`** — `fix(ci)`: bumped `oven-sh/setup-bun` from `1.1.0` to `1.4.0` in
   both `ci.yml` and `release.yml`. The repo's `bun.lock` is the text format
   (`lockfileVersion: 1`, stable since bun 1.2); bun 1.1.0 can't parse it and the
   frozen install failed with *"lockfile had changes, but lockfile is frozen"*.
   Commit `e63ebcc` had bumped the Dockerfile and `packageManager` but missed the
   `setup-bun` steps that actually run the frozen install. Verified locally: bun
   1.4.0 frozen install passes clean against the committed lockfile.
2. **`19b2355`** — `fix(release)`: lowercased the GHCR image paths. `IMAGE` /
   `HARNESS_IMAGE` interpolated `${{ github.repository_owner }}` (= `MuditGarg007`),
   but OCI repository names must be lowercase, so the build tagged an invalid
   reference. Hardcoded `ghcr.io/muditgarg007/...` (GHCR matches owner
   case-insensitively, so the `github.actor` login is unaffected).
3. **`b820b83`** — `fix(release)`: the Trivy steps passed `image-ref: $IMAGE:scan`,
   but a composite-action input is **not** shell-expanded, so Trivy got the literal
   string and failed with *"could not parse reference: $HARNESS_IMAGE:scan"*. Changed
   to the `${{ env.IMAGE }}:scan` expression form. (The `run:` shell steps that use
   `$IMAGE` are fine — bash expands those.)
4. **`efb0e6a` / trivy tag** — pinned `aquasecurity/trivy-action` as `@v0.24.0`
   (was `@0.24.0`; upstream removed the no-prefix tags, only `v`-prefixed remain).
5. **`b28250d`** — `fix(contracts)`: regenerated `packages/contracts/src/index.ts`.
   The drift gate (`packages/contracts/test/drift.spec.ts`) failed because the
   committed file still exported `CONTRACT_VERSION = '1.0.0'` while a fresh
   generation from the harness schema yields `'1.1.0'` (the M6a bump — the generated
   TS was never recommitted after the schema change). Only `CONTRACT_VERSION`
   changed; `event-schema.ts` already matched. Full workspace test suite passes
   locally (exit 0).
6. **`66337e8`** — `fix(release)`: set `ignore-unfixed: "true"` on both Trivy steps
   (owner-approved). The Debian base ships 44 HIGH OS CVEs (2026 util-linux/acl
   disclosures) with **no fixed version available**, so the gate was blocking every
   release on vulns that can't be remediated. The gate still fails on *fixable*
   HIGH/CRITICAL. A comment in `release.yml` says to revisit when the base publishes
   fixes.
7. **`4ce36fd`** — `fix(harness)`: bumped `urllib3` `2.7.0 → 2.8.0` in
   `harness/uv.lock` (via `uv lock --upgrade-package urllib3`). Trivy flagged two
   **fixable** HIGH CVEs in the harness image: CVE-2026-97687 (HTTPS-proxy TLS
   interception) and CVE-2026-97689 (unbounded-memory DoS). urllib3 is transitive
   (via httpx / langchain-openai). Only urllib3 changed in the lock. **Confirmed on
   the `4ce36fd` run: the harness Trivy scan now passes.**

## Remaining blockers

### B1 — CI: MinIO image removed from Docker Hub — RESOLVED (2026-10-06)

**Fix (option 1 / pin on an accessible registry):** the last official image
(`RELEASE.2025-09-07T16-13-09Z`, still in the local Docker cache) was mirrored to
`ghcr.io/muditgarg007/minio` (package made **public** → anonymous CI pull, no auth
wiring needed). Both call sites pinned to that ref in `c0ef889`; CI run
`37508093210` is green. The official contract is unchanged (`server /data`,
`MINIO_ROOT_*` env, `API:` ready log), so no test logic changed. quay.io/minio/minio
was confirmed **not** anonymously pullable (401) and `bitnamilegacy/minio` was
rejected — different entrypoint/data-dir would have forced a test rewrite.

Original analysis below (kept for history):



- **Symptom:** `@autosploit/control-plane#test` fails. Two integration tests —
  `control-plane/test/reports.spec.ts:79` and `control-plane/test/s3-sink.spec.ts:196`
  — start a Testcontainers `GenericContainer('minio/minio:latest')`. The pull 404s:
  *"pull access denied for minio/minio, repository does not exist"*.
- **Root cause:** `minio/minio` is **gone from Docker Hub** (the Hub API returns
  *"object not found"* for the whole repository). `quay.io/minio/minio` exists as a
  path but returns **0 tags** to an anonymous registry-v2 token, so it isn't an
  anonymous drop-in either. MinIO changed its community image distribution.
- **Why it's a decision, not a mechanical fix:** there is no anonymous
  drop-in replacement to resolve blindly. Pick one:
  1. Pin a specific MinIO `RELEASE.*` tag on a registry you have pull access to
     (and wire any needed auth into CI).
  2. Swap the object-store container to an alternative S3-compatible image
     (e.g. LocalStack S3, or an older mirrored MinIO release).
  3. Gate these two Docker-in-Docker tests out of the standard CI `test` task
     (e.g. tag them and run them only in a dedicated integration job).
- **Where to change:** the two `GenericContainer('minio/minio:latest')` call sites
  above (option 1/2), or the test tagging + the `test` script wiring (option 3).
- **Note:** the other 13 control-plane test files pass; only these two MinIO-backed
  ones fail. The surrounding Kafka/Redis log noise ("redis down", "no leader",
  "Topic creation errors") is from those same two tests' setup and is not a separate
  failure.

### B2 — Release: GHCR push denied (`permission_denied: write_package`) (owner setting)

- **Symptom:** `harness-build-push` → *"Build and push multi-arch manifest and emit
  digest"* fails: `denied: permission_denied: write_package` pushing
  `ghcr.io/muditgarg007/harness:<sha>`. The GHCR login and the scan/leak steps all
  succeed; only the actual write is refused. The control-plane `build-push` job will
  hit the same wall once B3 is cleared.
- **Root cause (most likely):** `release.yml` already declares `permissions:
  packages: write` at the workflow level, so the cap is above the workflow — the
  repo's **Settings → Actions → General → Workflow permissions** is set to read-only,
  which overrides the YAML request. The `GITHUB_TOKEN` then can't obtain a write
  scope regardless of the workflow block.
- **Fix (owner action):** set **Settings → Actions → General → Workflow permissions**
  to **"Read and write permissions"**. If it's already read-write, then the
  GHCR package exists but isn't linked to this repo with write access — open the
  package (`muditgarg007/harness`, and `muditgarg007/control-plane`) →
  **Package settings → Manage Actions access** → add the repo with the **Write**
  role. No code change is expected either way; re-run the Release workflow after.

### B3 — Release: control-plane image has fixable OS CVEs (stale base)

- **Symptom:** `build-push` (control-plane) Trivy gate fails: **66 HIGH + 5 CRITICAL,
  all with a fixed version available** (e.g. `perl-base` `5.36.0-7+deb12u3` →
  `deb12u4`). `ignore-unfixed` does not help — these have fixes. The image is built
  from a Debian 12 (bookworm) base via the `oven/bun` image, which is stale.
- **Fix options:**
  1. Add `apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*` to the
     control-plane Dockerfile (clears the fixed OS CVEs; smallest change). **This is
     mechanical and ready to do on the owner's go-ahead.**
  2. Bump the `oven/bun` base image to a newer digest/tag that already carries the
     patched packages.
- **Where:** `control-plane/Dockerfile`.

### B4 — Release: `redteam-kind` and `deploy-gke` not yet reached (infra)

- These jobs run after a successful build/push and have never executed in this
  recovery (the pipeline fails upstream). They need a kind cluster (red-team pass)
  and GKE credentials / an approval-gated environment (`autosploit-demo`,
  `us-central1`). They can't be validated from a developer laptop — expect to debug
  these once B1–B3 are green and secrets/approvals are confirmed.

## How to resume

1. **CI green:** decide B1 (MinIO), apply, push, confirm `@autosploit/control-plane#test`
   passes. The contracts drift fix is already in; no other CI test is failing.
2. **Release build/push green:** flip the repo workflow-permissions setting (B2), and
   apply the control-plane base upgrade (B3). Re-run Release.
3. **Release deploy:** work B4 (kind + GKE) once the image push succeeds.

### Verifying a run (don't trust a piped exit code)

`gh run watch <id> | tail` reports **`tail`'s** exit status, not the run's — this
masked a real failure earlier in the recovery. Read the conclusion explicitly:

```sh
gh run view <run-id> --json conclusion -q .conclusion
# per-job step detail:
gh run view --job <job-id>
# failing-step log with ANSI stripped:
gh api repos/MuditGarg007/AutoSploit-AI/actions/jobs/<job-id>/logs \
  --allow-escape-sequences | sed 's/\x1b\[[0-9;]*m//g'
```

## Local verification already done

- `bun install --frozen-lockfile` under bun 1.4.0 — passes clean.
- `packages/contracts` drift spec — passes.
- Full workspace `bun run test` — exit 0.
- `uv lock --upgrade-package urllib3` — only urllib3 changed (`2.7.0 → 2.8.0`).
