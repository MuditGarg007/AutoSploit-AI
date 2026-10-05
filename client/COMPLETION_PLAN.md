# Client completion plan

Goal: take the AutoSploit AI web client from its current mock-driven state to a
deploy-ready personal project on Vercel.

This plan is split into phases, and each phase into **Claude Code sessions**. One
session is meant to be one fresh CC context: a bounded scope, a short read list,
and a done-check. Start each session with `/clear`, open only the files that
session names, and stop when its done-check passes. That keeps context from
bloating across the build.

Convention per session below: **Goal**, **Read first** (the only files to load),
**Do**, **Done check**, **Keep out of context** (what not to open).

---

## Current state (audit, 2026-10-05)

Done:
- Landing page: Navbar, MicroSlats hero, Features, HowItWorks, Isolation, CTA,
  Footer.
- Auth screens: `app/login` (Clerk OAuth + email), `app/sso-callback`.
- Dashboard shell (Sidebar, Topbar), index (`app/dashboard`), live view
  (`app/dashboard/[id]`) with the full panel set.
- Live data path: `lib/events.ts` typed contract + pure `reduceEvent`,
  `hooks/useEngagementStream.ts` (SSE with mock fallback), `lib/mock-stream.ts`.
- Temp design reference route `app/design`.

Gaps (this plan closes them):
1. No `middleware.ts`. Clerk is installed but routes are not protected;
   `/dashboard` is reachable signed-out.
2. `/dashboard/new` is linked from the index and the detail header but the route
   does not exist (404).
3. All data is mock. No API client module. The control-plane endpoints (C/D/E)
   are now implemented and tested (`POST/GET /engagements`,
   `GET /engagements/:id`, `POST /engagements/:id/abort`,
   `GET /engagements/:id/stream`, `GET /engagements/:id/report`), so Phase 4 is
   no longer blocked on the backend shipping them. It is blocked only on the auth
   bridge (see Phase 4). Phases 0 to 3 stay mock-driven regardless.
4. Missing route files: `error.tsx`, `loading.tsx`, `not-found.tsx`.
5. `app/layout.tsx` metadata title uses an em dash, which breaks the hard copy
   rule in `client/CLAUDE.md`. Needs a sweep.
6. No tests, though `reduceEvent` and `lib/format.ts` are pure and built to be
   tested ("swap mock for live is a no-op").
7. `app/design` is a temp route and says to delete it before ship.
8. No deploy config: no `.env.example`, no README, no prod Clerk instance, no
   Vercel project notes.

Backend reality: the client can be fully deploy-ready as a polished, mock-driven
demo with real auth **now** (Phases 0 to 3). The control plane now serves the
five client endpoints, so Phase 4 is unblocked on the endpoint front. The one
remaining Phase 4 blocker is the auth model: the control plane issues its own
GitHub-OAuth session (slice A, cookie `SessionGuard`), while the client signs in
with Clerk. Forwarding a Clerk session to the API will not authenticate. That
bridge is a decision to make before S7, not a config swap.

Stack note: this repo pins a modified Next.js (16.3.6). Per `client/AGENTS.md`,
read the relevant guide under `node_modules/next/dist/docs/` before writing
routing, middleware, or metadata code. Do not assume training-data Next APIs.

---

## Phase 0 — Correctness and ship-blockers

Independent of the backend. Makes the app safe and whole on mock data.

### Session 1: Auth gate + routing integrity
- **Goal:** signed-out users cannot reach `/dashboard`; no dead links; standard
  error/loading/not-found routes exist; copy rule restored.
- **Read first:** `node_modules/next/dist/docs/` middleware + metadata guides,
  `app/layout.tsx`, `app/login/page.tsx`, `app/dashboard/page.tsx`.
- **Do:**
  - Add `middleware.ts` using `clerkMiddleware` and `createRouteMatcher`;
    protect `/dashboard(.*)`. Verify the matcher config against the installed
    Clerk v7 guide (this repo uses the new signals API; login already imports
    from `@clerk/nextjs/legacy`).
  - Add `app/not-found.tsx`, `app/error.tsx` ("use client"), `app/loading.tsx`,
    and `app/dashboard/loading.tsx`. Keep them on-palette (true black, hairline
    borders, no decoration per `client/CLAUDE.md`).
  - Fix the em dash in `app/layout.tsx` title. Then sweep the whole client for
    em dashes: `grep -rn "—" app components lib hooks` and rewrite each.
  - Confirm post-login redirect lands on `/dashboard` (Clerk env or
    `forceRedirectUrl`).
- **Done check:** `bun run build` passes; visiting `/dashboard` signed-out
  redirects to login; grep for em dashes is empty.
- **Keep out of context:** `components/MicroSlats.tsx` (1k lines, not needed),
  dashboard panels.

---

## Phase 1 — Complete the core flows on mock

Build the data-access seam and the one missing flow. Everything still runs on
mock, but through the same interface the live backend will use, so Phase 4 is a
config swap, not a rewrite (mirror the pattern already in `useEngagementStream`).

### Session 2: API client layer + consume it
- **Goal:** a single `lib/api.ts` is the only place that knows about the control
  plane. Index and detail pages read through it, falling back to mock when
  `NEXT_PUBLIC_API_URL` is unset.
- **Read first:** `../docs/control-plane.md` (endpoint table around lines 79 to
  81, dispatch around 99), `lib/mock-engagements.ts`, `lib/events.ts`,
  `app/dashboard/page.tsx`, `app/dashboard/[id]/page.tsx`.
- **Do:**
  - Create `lib/api.ts` with typed functions: `listEngagements()` (`GET
    /engagements`), `getEngagement(id)` (`GET /engagements/:id`),
    `createEngagement(input)` (`POST /engagements`, body `{ repoId: number }`
    only), `abortEngagement(id)` (`POST /engagements/:id/abort`), `getReport(id)`
    (`GET /engagements/:id/report`). Each hits the control plane when
    `NEXT_PUBLIC_API_URL` is set, else returns mock (reuse `MOCK_ENGAGEMENTS`).
    Same fallback contract as the SSE hook.
  - Refactor `app/dashboard/page.tsx` to call `listEngagements()` and
    `app/dashboard/[id]/page.tsx` to call `getEngagement(id)` for the label.
  - Keep the lifecycle/telemetry shapes aligned with `lib/events.ts`.
- **Done check:** both pages render identically on mock; with a fake
  `NEXT_PUBLIC_API_URL`, requests are attempted then fall back cleanly on error.
- **Keep out of context:** the live panel internals; MicroSlats; login.

### Session 3: New engagement flow
- **Goal:** `/dashboard/new` exists and creates an engagement (via
  `createEngagement`), then routes to its live view.
- **Read first:** `app/dashboard/page.tsx` (the link target), `lib/api.ts` (from
  S2), `components/dashboard/Panel.tsx`, `components/dashboard/PageHeader.tsx`,
  `../docs/control-plane.md` dispatch section (4.C) + repos section (4.B),
  `../docs/component-q-quota.md` (only for the 429 copy; caps are per-user
  operator config, NOT per-engagement form fields).
- **Do:**
  - Build `app/dashboard/new/page.tsx` inside `DashboardShell`. The real dispatch
    contract is `POST /engagements` with body `{ repoId }` only: the repo is
    **chosen from the user's own list** (`GET /repos` returns `{ id, fullName,
    name }`; `GET /repos/:id/deployable` is the deployable gate), not a free-text
    URL, and there are no scope or spend/token cap inputs. So the form is a repo
    picker (and a submit), not a settings form. On mock, drive the picker off
    `MOCK_ENGAGEMENTS` / a mock repo list. Follow the design rules in
    `client/CLAUDE.md` (one primary burgundy action, hairline borders).
  - On submit call `createEngagement({ repoId })`, then `router.push` to
    `/dashboard/<id>`. On mock, synthesize an id and route to the demo stream.
  - Handle the quota `429` path with a plain inline message (the cap that tripped
    is enforced server-side; the UI only renders the rejection).
- **Done check:** clicking "New engagement" opens the form; picking a repo and
  submitting routes to a live view; validation and the quota-reject message render.
- **Keep out of context:** landing components, tests.

---

## Phase 2 — Quality

### Session 4: Tests + CI
- **Goal:** the pure core is covered and lint/typecheck/test run in CI.
- **Read first:** `lib/events.ts`, `lib/format.ts`, `lib/mock-stream.ts`,
  `package.json`.
- **Do:**
  - Add Vitest. Unit-test `reduceEvent` (phase/tool pairing/orphan result/
    finding de-dupe/cost/halt), `isTerminal`, `severityRank`, and `lib/format`.
  - Add `test`, `typecheck` scripts to `package.json`.
  - Add a GitHub Actions workflow: install (bun), lint, typecheck, test, build.
    Keep it one file, personal-project scale.
- **Done check:** `bun run test` and `bun run typecheck` pass locally; CI green
  on a push.
- **Keep out of context:** UI components.

### Session 5: Polish and prune
- **Goal:** responsive, accessible, fast, indexable; temp route removed.
- **Read first:** `app/page.tsx`, `components/MicroSlats.tsx` (only if touching
  hero perf), `app/layout.tsx`, `app/design/page.tsx`.
- **Do:**
  - Delete `app/design` (route header says to).
  - Mobile pass on landing + dashboard (16px gutters, no horizontal scroll).
  - MicroSlats (ogl canvas): gate or reduce work on small screens / reduced
    motion; confirm it is `aria-hidden` and not blocking paint.
  - SEO/meta: favicon/icon set, OpenGraph + Twitter tags, `robots`. Extend
    `metadata` in `app/layout.tsx` per the installed Next metadata guide.
  - Quick a11y pass: focus states, labels on the new form, color contrast.
- **Done check:** Lighthouse mobile is healthy; no console errors; `/design`
  gone; build passes.
- **Keep out of context:** api layer, tests.

---

## Phase 3 — Deploy

### Session 6: Vercel deploy + prod auth
- **Goal:** live on Vercel with a production Clerk instance and documented env.
- **Read first:** `app/layout.tsx`, `middleware.ts`, `.env.local` (names only),
  `next.config.ts`.
- **Do:**
  - Add `.env.example` (names only): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
    `CLERK_SECRET_KEY`, `NEXT_PUBLIC_API_URL`, Clerk redirect URLs.
  - Create a production Clerk instance; set OAuth (Google, GitHub) redirect URLs
    for the prod domain.
  - Create the Vercel project, set env vars (consider `vercel env`), deploy a
    preview, then promote. Add `next.config` image `remotePatterns` only if
    remote images are used.
  - Write `client/README.md`: what it is, local dev, env, deploy, the mock vs
    live `NEXT_PUBLIC_API_URL` switch.
- **Done check:** production URL loads; sign-in works end to end; dashboard
  renders on mock (no `NEXT_PUBLIC_API_URL` set yet).
- **Keep out of context:** component internals, tests.

---

## Phase 4 — Live backend wiring (gated on the control plane)

The control plane already serves `POST/GET /engagements`, `GET /engagements/:id`,
`POST /engagements/:id/abort`, `GET /engagements/:id/stream`, and
`GET /engagements/:id/report` (implemented + tested in `control-plane/`). The
remaining blocker is **auth**: the control plane authenticates with its own
GitHub-OAuth cookie session (`SessionGuard`), not Clerk. Resolve that bridge
before S7 (options: a control-plane endpoint that trades a verified Clerk token
for a control-plane session; or move the client onto the control plane's OAuth).

### Session 7: Connect to the real control plane
- **Goal:** set `NEXT_PUBLIC_API_URL` and run against live data with no
  component changes.
- **Read first:** `lib/api.ts`, `hooks/useEngagementStream.ts`, `lib/events.ts`,
  control-plane + telemetry docs.
- **Do:**
  - Point `NEXT_PUBLIC_API_URL` at the deployed control plane. Resolve auth
    first: the API rejects a Clerk session, so either stand up the Clerk-to-
    control-plane session bridge or adopt the control plane's GitHub OAuth. Then
    confirm CORS/SSE `withCredentials` works cross-origin with whatever session
    the bridge issues.
  - Verify the SSE resume path (`Last-Event-ID`) and the lifecycle states match
    `EngagementState`.
  - Re-check `createEngagement` against the real dispatch contract + quota `429`.
- **Done check:** a real engagement created from the UI streams live, lists on
  the index, and aborts; report link resolves.
- **Keep out of context:** landing, design, tests unless a contract changed.

---

## Session order summary

| Phase | Session | Scope | Depends on |
|------|---------|-------|------------|
| 0 | S1 | Auth gate, error/loading/not-found, em-dash sweep | - |
| 1 | S2 | `lib/api.ts` + consume in index/detail | S1 |
| 1 | S3 | New engagement form + create flow | S2 |
| 2 | S4 | Vitest tests + CI | S2 |
| 2 | S5 | Responsive/a11y/perf/SEO, remove `/design` | S1 to S3 |
| 3 | S6 | Vercel deploy + prod Clerk + README | S1 to S5 |
| 4 | S7 | Live control-plane wiring | auth bridge |

S2 and S4 can overlap; S4 only needs the pure modules. Everything through S6 is
doable now on mock. The control-plane endpoints exist, so S7 waits only on the
Clerk-to-control-plane auth bridge, not on the backend.
