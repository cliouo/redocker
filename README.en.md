[简体中文](./README.md) | **English**

# redocker

A **multi-registry pull-through mirror** (Docker Hub, ghcr.io, quay.io, gcr.io, registry.k8s.io, …) that runs on **Vercel's free (Hobby) tier**, bound to your own domain. It speaks the Docker Registry v2 HTTP API, transparently handling the token-auth dance, multi-arch manifests, the `library/` namespace, and layer (blob) delivery.

## 🚀 One-click deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/cliouo/redocker&env=DOCKER_USERNAME,DOCKER_PASSWORD&envDescription=Docker%20Hub%20username%20%2B%20a%20Personal%20Access%20Token%20(use%20a%20throwaway%20account)%20for%20authenticated%20pulls&envLink=https://github.com/cliouo/redocker/blob/main/README.en.md%23environment-variables&project-name=redocker&repository-name=redocker)

Clicking it clones this repo into your Vercel account and prompts for `DOCKER_USERNAME` / `DOCKER_PASSWORD`. After it deploys, two manual steps remain (Vercel can't automate them): **[disable Deployment Protection](#1-disable-deployment-protection-critical)** and **[bind your domain](#3-bind-your-domain)**. Then point Docker at it — see [below](#point-docker-at-it).

> **Feasibility: GO (with caveats).** The full pull flow has been validated end-to-end (10/10) against real Docker Hub content. The caveats are about free-tier *economics* (bandwidth, rate limits), not correctness — see [Limits & caveats](#limits--caveats).

---

## How it works

`docker pull` is a sequence of HTTP calls. The proxy sits in front of `registry-1.docker.io` and rewrites just enough to keep the client coming back through it:

```
docker client                redocker (Vercel)              Docker Hub
     │  GET /v2/                    │                            │
     │ ───────────────────────────►│  GET /v2/                  │
     │                             │ ──────────────────────────►│
     │                             │ ◄── 401 WWW-Authenticate ──│  realm=auth.docker.io
     │ ◄── 401, realm REWRITTEN ───│      (realm → /v2/auth)     │
     │  GET /v2/auth?scope&service  │                            │
     │ ───────────────────────────►│  GET auth.docker.io/token  │
     │                             │ ──(+ your PAT, optional)──►│
     │ ◄────────── token ──────────│ ◄────────── token ─────────│
     │  GET .../manifests/<ref>     │                            │
     │ ───────────────────────────►│ ─────────────────────────►│  (Accept negotiated, multi-arch)
     │ ◄────────── manifest ───────│ ◄───────── manifest ───────│
     │  GET .../blobs/<digest>      │                            │
     │ ───────────────────────────►│ ─────────────────────────►│  307 → CDN
     │ ◄─── layer bytes (stream) ───│ ◄═══════ stream ═══════════╛
```

- **Token realm rewrite** — every `401` has its `WWW-Authenticate` `realm` rewritten to `/v2/auth` so auth always flows through the proxy (this is also what lets the proxy inject *your* Docker Hub credentials).
- **`library/` expansion** — `docker pull yourdomain/nginx` (single name) is `301`-redirected to `library/nginx`.
- **Multi-registry** — a first path segment containing a dot (e.g. `/v2/ghcr.io/...`) is routed to that registry. See [Point Docker at it](#point-docker-at-it).
- **Blob delivery** — two strategies, see [`BLOB_MODE`](#environment-variables).
- **Stateless** — no caching layer; Docker's *local* layer cache means already-pulled layers aren't re-fetched.

Code map:
- `src/proxy.js` — the runtime-agnostic core (Web-standard `fetch`/`Request`/`Response` only).
- `src/node-adapter.js` — bridges Node `(req,res)` ⇄ the core, streaming the body.
- `api/proxy.js` — the Vercel serverless function (Node runtime); all paths route here via `vercel.json`.
- `local-server.js` — runs the **same** adapter locally for testing.
- `test/` — full v2-flow curl test + deterministic routing/redirect unit tests.

---

## Local test (reproduce the validation)

Deterministic unit tests (mock the network, no docker needed):

```bash
npm run test:unit     # routing + blob-mode logic, 20 checks
```

Full v2 flow with `curl` against a real upstream. Because Docker Hub is blocked on some networks (e.g. behind the GFW), point the test at a reachable Docker Hub mirror:

```bash
# Terminal 1 — start the proxy against a reachable Docker Hub mirror
UPSTREAM_REGISTRY=https://docker.m.daocloud.io \
UPSTREAM_AUTH=https://m.daocloud.io/auth \
UPSTREAM_SERVICE=docker.m.daocloud.io \
LIBRARY_REDIRECT=1 \
node local-server.js

# Terminal 2 — walk the flow
BASE=http://localhost:8787 bash test/v2-flow.sh
# => 10 passed, 0 failed
```

The flow test proves: `401` + realm rewrite, `library/` redirect, token forwarding, multi-arch index negotiation, `HEAD` + `Docker-Content-Digest`, and a **byte-exact blob download (sha256 matches the digest)**.

---

## Deploy to Vercel

**Easiest:** click the **[one-click Deploy button](#-one-click-deploy)** at the top. Or via CLI:

```bash
npm i -g vercel        # or use `npx vercel`
cd redocker
vercel                 # link/create a project (first run = preview)
vercel --prod          # production deploy
```

Either way, complete these steps:

### 1. Disable Deployment Protection (critical)
New Vercel projects often enable **Vercel Authentication**, which puts an SSO login page in front of every request. A docker client can't log in, so pulls would fail with HTML.

> Dashboard → your project → **Settings → Deployment Protection → Vercel Authentication → Disabled** (for Production).

### 2. Set environment variables (strongly recommended)
> Dashboard → **Settings → Environment Variables**, or `vercel env add NAME`.

Set `DOCKER_USERNAME` + `DOCKER_PASSWORD` so pulls are authenticated to *your* account (per-account rate limit) instead of the shared anonymous-per-IP bucket of Vercel's egress. See [Limits & caveats](#limits--caveats) for why this matters and the throwaway-account note.

### 3. Bind your domain
> Dashboard → **Settings → Domains → Add**, then create the DNS record Vercel shows you:
> - **Subdomain** (e.g. `docker.example.com`): `CNAME` → `cname.vercel-dns.com`
> - **Apex** (e.g. `example.com`): `A` → `76.76.21.21`

Vercel issues TLS automatically. (Use a custom domain — the default `*.vercel.app` host can be unreachable on some networks.)

### 4. Verify the deployment
```bash
curl -i https://YOUR_DOMAIN/v2/
# Expect: HTTP/2 401  +  www-authenticate: Bearer realm="https://YOUR_DOMAIN/v2/auth",service="registry.docker.io"
```

---

## Point Docker at it

**Option A — registry mirror (Docker Hub only, transparent):**
```json
// Linux: /etc/docker/daemon.json   |   macOS/Win: Docker Desktop → Settings → Docker Engine
{ "registry-mirrors": ["https://YOUR_DOMAIN"] }
```
Restart Docker, then pull normally:
```bash
docker pull nginx          # goes through your mirror
docker pull hello-world
```

**Option B — explicit prefix (works for any tag, no daemon change):**
```bash
docker pull YOUR_DOMAIN/library/nginx:latest
docker pull YOUR_DOMAIN/nginx                       # auto-expands to library/nginx
```

**Option C — other registries (prefix with the registry host):**
```bash
docker pull YOUR_DOMAIN/ghcr.io/astral-sh/uv:latest
docker pull YOUR_DOMAIN/quay.io/podman/hello:latest
docker pull YOUR_DOMAIN/gcr.io/distroless/static:latest
docker pull YOUR_DOMAIN/registry.k8s.io/pause:3.9
```
A first path segment containing a dot (e.g. `ghcr.io`) is treated as the upstream registry host; Docker Hub namespaces never contain dots, so there's no ambiguity. `registry-mirrors` only mirrors Docker Hub, so use this prefix form for everything else.

**Supported registries:** `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `registry.k8s.io`, `k8s.gcr.io`, `mcr.microsoft.com`, `public.ecr.aws`, `registry.gitlab.com`, `nvcr.io`, and `*.pkg.dev` (Google Artifact Registry). Add more with the `EXTRA_REGISTRIES` env var. Anything not on the allowlist returns `404` (so the proxy can't be abused as an open relay). Registries needing your own credentials (e.g. AWS ECR, private repos) only work for anonymous/public images here.

---

## Private images (log in per registry)

Private images need a **per-registry login**, so use a **registry subdomain** (not the path prefix). The proxy **forwards** your credentials to that registry and **never stores them**, so private images stay private — only someone with the real credentials can pull.

One-time setup (per registry you log into):
1. Add the subdomain to the SAME Vercel project: Settings → Domains → Add `ghcr.YOUR_DOMAIN`; DNS `CNAME → cname.vercel-dns.com`.
2. Log in and pull (a ghcr PAT needs the `read:packages` scope):
```bash
echo <YOUR_GHCR_PAT> | docker login ghcr.YOUR_DOMAIN -u <YOUR_GH_USERNAME> --password-stdin
docker pull ghcr.YOUR_DOMAIN/owner/private-image:tag
```

**Subdomain → registry map:** `ghcr`→ghcr.io, `quay`→quay.io, `gcr`→gcr.io, `k8s`→registry.k8s.io, `mcr`→mcr.microsoft.com, `ecr`→public.ecr.aws, `gitlab`→registry.gitlab.com, `nvcr`→nvcr.io, `docker`→Docker Hub. Add more with `EXTRA_SUBDOMAINS="label=host"`.

> ⚠️ **Security:** never put a private-repo token in the proxy's env vars on a public deployment — that exposes those images to anyone who can reach the proxy. The subdomain + login flow keeps credentials client-side.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DOCKER_USERNAME` | — | Docker Hub username for authenticated pulls (rate-limit attribution). |
| `DOCKER_PASSWORD` | — | A Docker Hub **Personal Access Token** (not your password). |
| `BLOB_MODE` | `stream` | `stream`: proxy fetches & streams layer bytes (true acceleration, uses Vercel bandwidth). `redirect`: hand the CDN `307` back to the client (saves bandwidth, but the client must be able to reach the CDN). |
| `LIBRARY_REDIRECT` | auto | Force the `library/` namespace redirect on/off (auto-on for Docker Hub). |
| `EXTRA_REGISTRIES` | — | Comma-separated extra registry hosts to allow as path prefixes (beyond the built-in allowlist). |
| `EXTRA_SUBDOMAINS` | — | Extra "subdomain-label=registry-host" mappings, comma-separated (e.g. `gitlab=registry.gitlab.com`). |
| `UPSTREAM_REGISTRY` | `https://registry-1.docker.io` | Default upstream (used when no registry-host prefix is given). |
| `UPSTREAM_AUTH` | `https://auth.docker.io` | Upstream token service (proxy appends `/token`). |
| `UPSTREAM_SERVICE` | `registry.docker.io` | The token `service` value. |

---

## Limits & caveats

Validated as feasible for **personal, low-volume** use. Know these before relying on it:

- **Reachability** — Vercel's edge is reachable & fast from most networks (incl. behind the GFW, tested via a Vercel-hosted site at ~0.45s). Always go through your **custom domain**; the default `*.vercel.app` may be blocked.
- **Bandwidth (the main free-tier limit)** — Hobby includes **100 GB/month egress with no overage**; exceeding it *pauses* the project for the rest of the cycle. In `stream` mode every layer byte counts. Mitigations: Docker's local layer cache avoids re-pulls; switch to `BLOB_MODE=redirect` to keep bytes off Vercel (only if your client can reach the CDN).
- **Rate limiting** — Docker Hub limits anonymous pulls (≈10/hr unauth, more when authenticated) and Vercel egresses from **shared IPs**, so the anonymous bucket can already be exhausted by others. **Set `DOCKER_USERNAME`/`DOCKER_PASSWORD`.** A free Docker PAT has write/delete scope, so use a **dedicated throwaway account that owns no repositories**.
- **300s function limit** — a single multi-GB layer over a slow link can time out in `stream` mode. Fine for normal images.
- **`BLOB_MODE=redirect` + containerd clients** — containerd-backed clients (Docker Engine 29+ default) can fail to follow a cross-host `307`. If pulls fail in redirect mode, use `stream`.
- **Terms** — Hobby is **personal / non-commercial** use only. A high-traffic public mirror can trip Vercel's fair-use policy; for commercial/CI use, upgrade to Pro.
- **No server-side cache** — this is a stateless proxy, not a caching mirror. Every cold pull is a live upstream round-trip.

---

Made for personal Docker image acceleration. PRs/issues welcome.
