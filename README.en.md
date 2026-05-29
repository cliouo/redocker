[简体中文](./README.md) | **English**

# redocker

> A multi-registry Docker pull-through proxy you deploy to Vercel's free tier in one click.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/cliouo/redocker&env=DOCKER_USERNAME,DOCKER_PASSWORD&envDescription=Docker%20Hub%20username%20%2B%20a%20Personal%20Access%20Token%20(use%20a%20throwaway%20account)%20for%20authenticated%20pulls&envLink=https://github.com/cliouo/redocker/blob/main/README.en.md%23configuration&project-name=redocker&repository-name=redocker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

redocker mirrors Docker Hub and other registries (ghcr.io, quay.io, gcr.io, registry.k8s.io, …) through a single Vercel Function bound to your own domain. Point Docker at it to speed up or unblock image pulls — with no server to run.

## Features

- **One-click deploy** to Vercel's free Hobby plan, on your own domain.
- **Docker Hub mirror** — a drop-in `registry-mirrors` entry.
- **Any registry** — `docker pull your-domain/ghcr.io/owner/image`.
- **Private images** — log in to a registry subdomain; your credentials are forwarded to the upstream, never stored.
- **Streaming** layer delivery (exempt from Vercel's 4.5 MB body limit), plus an optional bandwidth-saving redirect mode.
- **Authenticated Docker Hub pulls** with your own token, so rate limits count against your account — not Vercel's shared IPs.
- **Allowlisted** upstreams — not an open relay.

## Quick start

1. **Deploy** — click the button above (or run `npx vercel`). The one-click flow asks for `DOCKER_USERNAME` and `DOCKER_PASSWORD` (your Docker Hub username + an access token) — see the note below for why.
2. **Add your domain** — *Settings → Domains*, add your (sub)domain and create a `CNAME → cname.vercel-dns.com`. TLS is automatic.
3. **Verify**:
   ```bash
   curl -i https://YOUR_DOMAIN/v2/
   # → HTTP/2 401, with:
   #   www-authenticate: Bearer realm="https://YOUR_DOMAIN/v2/auth",service="registry.docker.io"
   ```

> [!IMPORTANT]
> **redocker uses your own Docker Hub account.** Vercel egresses from shared IPs, and Docker Hub's anonymous pull limit is per-IP — often already exhausted by others on the same IP (`429`). With `DOCKER_USERNAME` + `DOCKER_PASSWORD` (an access token) set, pulls authenticate as your account (~200 per 6h, counted per account), which is what makes it reliable — so the one-click deploy marks them required. (It still runs anonymously without them, but anonymous pulls are easily rate-limited on shared IPs.)
>
> Because it carries your Docker Hub credentials, **this is for personal use — don't share the proxy URL publicly**, or others will spend your account's quota. Use a **throwaway account** token (a free token has write/delete scope).

> [!NOTE]
> If a pull returns an HTML login page instead of JSON, the project has **Deployment Protection** enabled (off by default for Production); turn it off under *Settings → Deployment Protection*.

## Usage

### As a Docker Hub mirror

```jsonc
// Linux: /etc/docker/daemon.json — macOS/Windows: Docker Desktop → Settings → Docker Engine
{ "registry-mirrors": ["https://YOUR_DOMAIN"] }
```

Restart Docker, then `docker pull nginx` as usual.

### Pull any public image (by prefix)

```bash
docker pull YOUR_DOMAIN/library/nginx:latest         # Docker Hub
docker pull YOUR_DOMAIN/nginx                         # short form → library/nginx
docker pull YOUR_DOMAIN/ghcr.io/astral-sh/uv:latest   # GitHub Container Registry
docker pull YOUR_DOMAIN/quay.io/podman/hello:latest   # Quay
docker pull YOUR_DOMAIN/registry.k8s.io/pause:3.9     # Kubernetes
```

A first path segment containing a dot (`ghcr.io`) is treated as the upstream registry; Docker Hub namespaces never contain dots, so there's no ambiguity. `registry-mirrors` only mirrors Docker Hub, so use this form for everything else.

Built-in registries: `docker.io`, `ghcr.io`, `quay.io`, `gcr.io`, `registry.k8s.io`, `k8s.gcr.io`, `mcr.microsoft.com`, `public.ecr.aws`, `registry.gitlab.com`, `nvcr.io`, `*.pkg.dev`. Add more with `EXTRA_REGISTRIES`.

### Private images

Private images need a per-registry login, so use a **registry subdomain** and log in there. The proxy forwards your credentials to the upstream and never stores them.

```bash
# one-time: add ghcr.YOUR_DOMAIN to the SAME Vercel project (Settings → Domains) + a CNAME record
echo <TOKEN> | docker login ghcr.YOUR_DOMAIN -u <USERNAME> --password-stdin
docker pull ghcr.YOUR_DOMAIN/owner/private-image:tag
```

Subdomain → registry: `ghcr`, `quay`, `gcr`, `k8s`, `mcr`, `ecr`, `gitlab`, `nvcr`, `docker`. Add more with `EXTRA_SUBDOMAINS="label=host"`. (A ghcr token needs the `read:packages` scope.)

> [!WARNING]
> Don't put a private-repo token in the proxy's environment variables on a public deployment — that exposes those images to anyone who can reach it. The subdomain-login flow keeps credentials on the client.

## Configuration

`DOCKER_USERNAME` / `DOCKER_PASSWORD` are set during the one-click deploy (see the note above); the rest are optional. Adjust them in the Vercel dashboard (*Settings → Environment Variables*) or with `vercel env add`.

| Variable | Default | Description |
|---|---|---|
| `DOCKER_USERNAME` / `DOCKER_PASSWORD` | **required** | Docker Hub username + access token. Authenticated pulls count against your account's rate limit instead of Vercel's shared-IP anonymous bucket (which is easily `429`'d). Use a **throwaway account** — a free token has write/delete scope. |
| `BLOB_MODE` | `stream` | `stream` proxies layer bytes (real acceleration, uses Vercel bandwidth). `redirect` hands the CDN `307` back to the client (saves bandwidth; the client must be able to reach the CDN). |
| `EXTRA_REGISTRIES` | — | Extra registry hosts for prefix routing, comma-separated. |
| `EXTRA_SUBDOMAINS` | — | Extra `label=host` subdomain mappings, comma-separated. |
| `LIBRARY_REDIRECT` | auto | Force `library/` expansion on/off (auto-on for Docker Hub). |
| `UPSTREAM_REGISTRY` / `UPSTREAM_AUTH` / `UPSTREAM_SERVICE` | Docker Hub | Override the default upstream (e.g. to chain through another Docker Hub mirror). |

## How it works

`docker pull` is a sequence of Registry v2 HTTP calls. redocker proxies them and rewrites just enough to keep the client coming back through it — chiefly the `WWW-Authenticate` realm, so authentication (and optional credential injection) always flows through the proxy.

<details><summary>Pull sequence</summary>

```
docker client                redocker (Vercel)              registry
     │  GET /v2/                    │                            │
     │ ───────────────────────────►│ ──────────────────────────►│
     │                             │ ◄── 401 WWW-Authenticate ──│
     │ ◄── 401, realm REWRITTEN ───│      (realm → /v2/auth)     │
     │  GET /v2/auth?scope&service  │                            │
     │ ───────────────────────────►│  GET <realm>/token         │
     │                             │ ──(+ credentials)─────────►│
     │ ◄────────── token ──────────│ ◄────────── token ─────────│
     │  GET .../manifests/<ref>     │                            │
     │ ───────────────────────────►│ ─────────────────────────►│
     │ ◄────────── manifest ───────│ ◄───────── manifest ───────│
     │  GET .../blobs/<digest>      │                            │
     │ ───────────────────────────►│ ─────────────────────────►│  307 → CDN
     │ ◄─── layer bytes (stream) ───│ ◄═══════ stream ═══════════╛
```

</details>

- **Token realm rewrite** — every `401`'s realm points back to `/v2/auth`.
- **`library/` expansion** — single-name Docker Hub images `301` to `library/<name>`.
- **Routing** — apex domain: Docker Hub plus `/v2/<host>/…` prefixes; a registry subdomain pins the whole host to one upstream (which is what makes per-registry login work).
- **Blobs** — streamed through (or `307`-redirected). `fetch` drops `Authorization` on the cross-origin CDN hop, so tokens never leak.
- **Stateless** — no server cache; Docker's local layer cache avoids re-pulls.

## Development

```bash
npm run test:unit     # deterministic routing/auth tests (mocked network)

# End-to-end flow against a real upstream (curl speaks the same API as docker).
# Use a reachable Docker Hub mirror as the upstream if docker.io is blocked:
UPSTREAM_REGISTRY=https://docker.m.daocloud.io \
UPSTREAM_AUTH=https://m.daocloud.io/auth \
UPSTREAM_SERVICE=docker.m.daocloud.io \
LIBRARY_REDIRECT=1 node local-server.js &
BASE=http://localhost:8787 bash test/v2-flow.sh
```

Layout: `src/proxy.js` (runtime-agnostic core) · `src/node-adapter.js` (Node ⇄ Web bridge) · `api/proxy.js` (Vercel function) · `local-server.js` (local dev server) · `test/`.

## Limitations

Built for **personal, low-volume** use on Vercel's free tier.

- **Bandwidth** — Hobby includes 100 GB/month egress with no overage; exceeding it pauses the project until the next cycle. `stream` mode counts every layer byte; Docker's local cache and `BLOB_MODE=redirect` help.
- **Rate limits** — set `DOCKER_USERNAME`/`DOCKER_PASSWORD` so Docker Hub pulls aren't throttled on Vercel's shared IPs.
- **Function duration** — 300 s; a single multi-GB layer over a slow link can time out in `stream` mode.
- **Terms** — the Hobby plan is for personal, non-commercial use.
- **No server-side cache** — every cold pull is a live upstream round-trip.

## License

[MIT](./LICENSE)
