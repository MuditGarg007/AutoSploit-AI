# AutoSploit AI, web client

The operator-facing web client for AutoSploit AI: a dashboard to launch
autonomous red-team engagements, watch them stream live, and read their reports.
Built with Next.js (App Router) and Clerk auth.

The client runs in two modes. By default it is a fully functional, mock-driven
demo: every data path (engagement list, detail, live stream) serves local mock
data, so the app is deployable and browsable without any backend. Set
`NEXT_PUBLIC_API_URL` and it talks to the live control plane instead, with no
component changes (see [Mock vs live](#mock-vs-live)).

## Stack

- Next.js `16.3.6` (App Router). This repo pins a modified Next build; the
  `middleware` file convention is renamed to `proxy` (see `proxy.ts`). Read the
  guide under `node_modules/next/dist/docs/` before changing routing,
  middleware, or metadata code, not training-data Next APIs.
- Clerk v7 for auth (Google + GitHub OAuth, email/password). Routes under
  `/dashboard` are gated in `proxy.ts`.
- Tailwind CSS v4.
- Vitest for the pure core (`lib/events.ts`, `lib/format.ts`).
- Package manager: Bun.

## Local development

```bash
bun install
cp .env.example .env.local   # then fill in the Clerk keys
bun run dev
```

Open http://localhost:3000. With no `NEXT_PUBLIC_API_URL` set, the dashboard
runs on mock data.

### Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Dev server |
| `bun run build` | Production build |
| `bun run start` | Serve the production build |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Vitest (run once) |
| `bun run test:watch` | Vitest watch |

## Environment variables

See `.env.example` for the full list. Summary:

| Name | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | Clerk publishable key |
| `CLERK_SECRET_KEY` | yes | Clerk secret key |
| `NEXT_PUBLIC_SITE_URL` | prod | Absolute origin for OG/Twitter images, canonical, robots |
| `NEXT_PUBLIC_API_URL` | no | Live control-plane base URL. Unset = mock mode |

`.env*` is gitignored. Never commit real secrets; set them in the Vercel
project instead.

## Mock vs live

The client knows about the control plane in exactly one place per concern:
`lib/api.ts` (list/get/create/abort/report) and `hooks/useEngagementStream.ts`
(the SSE stream). Both follow the same rule: when `NEXT_PUBLIC_API_URL` is set
they hit the real endpoint and fall back to mock on error; when it is unset they
serve mock directly. Switching from demo to live is therefore a config change
(set the var), not a code change.

Live wiring (Phase 4) is gated on the auth bridge: the control plane
authenticates with its own GitHub-OAuth cookie session, not Clerk. That bridge
must be resolved before pointing `NEXT_PUBLIC_API_URL` at the deployed API.

## Deploy (Vercel)

1. Create a **production Clerk instance** in the Clerk dashboard. Configure the
   Google and GitHub OAuth providers and add the production domain to the
   instance's allowed origins / redirect URLs.
2. Create a Vercel project from this repo (root directory: `client/`).
3. Set the environment variables above in the Vercel project (Production, and
   Preview if you want protected previews). Use the production Clerk keys for
   Production. Set `NEXT_PUBLIC_SITE_URL` to the production origin. Leave
   `NEXT_PUBLIC_API_URL` unset to ship the mock-driven demo.
4. Deploy a preview, verify sign-in and the dashboard, then promote to
   production.
