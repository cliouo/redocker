// redocker — Docker Registry v2 pull-through proxy core.
//
// Web-standard APIs only (fetch / Request / Response / URL / ReadableStream),
// so the exact same module runs on Vercel Edge runtime AND on Node 18+ (for
// local testing). No Node- or Cloudflare-specific globals.
//
// Two routing modes:
//   • APEX host (e.g. redocker.example.com) — public pulls. Docker Hub by
//     default; /v2/<registry-host>/<repo>/... routes to that registry by path
//     prefix. Anonymous (Docker Hub uses the owner's PAT for rate-limit).
//   • REGISTRY SUBDOMAIN (e.g. ghcr.redocker.example.com) — the whole host is
//     pinned to one upstream registry. This is what makes `docker login` work
//     per-registry, so PRIVATE images pull through with the CLIENT's own
//     credentials (forwarded, never stored by the proxy).

const DEFAULTS = {
  registry: "https://registry-1.docker.io",
  auth: "https://auth.docker.io",
  service: "registry.docker.io",
};

// Registries reachable via the /v2/<host>/... path prefix on the apex domain.
// An allowlist (not "any host") so the deployment isn't an open relay. Extend
// via EXTRA_REGISTRIES.
const DEFAULT_REGISTRIES = [
  "docker.io",
  "registry-1.docker.io",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "registry.k8s.io",
  "k8s.gcr.io",
  "mcr.microsoft.com",
  "public.ecr.aws",
  "registry.gitlab.com",
  "nvcr.io",
];
const ALLOWED_SUFFIXES = [".pkg.dev"]; // Google Artifact Registry regional hosts

// First DNS label of the request host -> upstream registry (subdomain mode).
// Extend via EXTRA_SUBDOMAINS="label=host,label2=host2".
const SUBDOMAIN_REGISTRY = {
  ghcr: "ghcr.io",
  quay: "quay.io",
  gcr: "gcr.io",
  k8s: "registry.k8s.io",
  mcr: "mcr.microsoft.com",
  ecr: "public.ecr.aws",
  gitlab: "registry.gitlab.com",
  nvcr: "nvcr.io",
  docker: "registry-1.docker.io",
  dockerhub: "registry-1.docker.io",
};

// Hop-by-hop headers must never be forwarded (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Request headers we never forward upstream. (Authorization IS forwarded.)
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-vercel-id",
  "x-vercel-deployment-url",
  "x-vercel-forwarded-for",
]);

function isDockerHub(registry) {
  return registry.includes("registry-1.docker.io") || registry.includes("docker.io");
}

function allowedRegistries(env) {
  const set = new Set(DEFAULT_REGISTRIES);
  if (env.EXTRA_REGISTRIES) {
    for (const r of String(env.EXTRA_REGISTRIES).split(",")) {
      const h = r.trim();
      if (h) set.add(h);
    }
  }
  return set;
}

// Is this path segment an explicit registry host (vs a Docker Hub namespace)?
function isRegistryHost(seg, env) {
  if (!seg || !seg.includes(".")) return false; // Docker Hub namespaces have no dots
  if (allowedRegistries(env).has(seg)) return true;
  return ALLOWED_SUFFIXES.some((s) => seg.endsWith(s));
}

// Registry host -> API base URL (Docker Hub's API host differs from its name).
function registryBase(host) {
  if (host === "docker.io" || host === "registry-1.docker.io" || host === "index.docker.io") {
    return DEFAULTS.registry;
  }
  return `https://${host}`;
}

// Request host -> pinned upstream registry (subdomain mode), or null for apex.
function registryFromHost(host, env) {
  if (!host) return null;
  const label = host.split(".")[0].toLowerCase();
  const map = { ...SUBDOMAIN_REGISTRY };
  if (env.EXTRA_SUBDOMAINS) {
    for (const pair of String(env.EXTRA_SUBDOMAINS).split(",")) {
      const [k, v] = pair.split("=").map((s) => (s ? s.trim() : s));
      if (k && v) map[k] = v;
    }
  }
  return map[label] || null;
}

function filterRequestHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (DROP_REQUEST_HEADERS.has(lk)) continue;
    out.set(k, v);
  }
  return out;
}

function buildResponseHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    out.set(k, v);
  }
  // If fetch transparently decompressed the body, the original length/encoding
  // no longer describe the bytes we are about to send.
  if (headers.has("content-encoding")) {
    out.delete("content-encoding");
    out.delete("content-length");
  }
  return out;
}

function forward(resp) {
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: buildResponseHeaders(resp.headers),
  });
}

// Rewrite `realm="https://auth.docker.io/token"` -> our own token endpoint so
// the docker client comes back to us for the token. Works for any upstream —
// only the realm is swapped; service/scope/other params are preserved.
function rewriteAuthenticate(value, origin) {
  return value.replace(/realm="[^"]*"/i, `realm="${origin}/v2/auth"`);
}

// Docker Hub official-image namespace expansion: /v2/<name>/<verb>/<ref> (single
// name, 5 segments) -> /v2/library/<name>/... Returns a 301 Response or null.
function libraryExpand(url, pathname, search) {
  const parts = pathname.split("/");
  const verbs = ["manifests", "blobs", "tags"];
  if (parts.length === 5 && verbs.includes(parts[3]) && parts[2] !== "library") {
    parts.splice(2, 0, "library");
    return Response.redirect(`${url.origin}${parts.join("/")}${search}`, 301);
  }
  return null;
}

async function handleToken(url, env, clientAuth, hostRegistry) {
  const service = url.searchParams.get("service") || DEFAULTS.service;
  const isHub = hostRegistry
    ? isDockerHub(hostRegistry)
    : service === DEFAULTS.service || service === "docker.io";

  // Docker Hub: realm is known. A logged-in client (clientAuth) pulls as itself
  // (e.g. private repos); otherwise inject the owner's PAT for rate-limit
  // attribution on anonymous/public pulls.
  if (isHub) {
    const authBase = env.UPSTREAM_AUTH || DEFAULTS.auth;
    const headers = new Headers({ accept: "application/json" });
    if (clientAuth) headers.set("authorization", clientAuth);
    else if (env.DOCKER_USERNAME && env.DOCKER_PASSWORD) {
      headers.set("authorization", "Basic " + btoa(`${env.DOCKER_USERNAME}:${env.DOCKER_PASSWORD}`));
    }
    return forward(await fetch(`${authBase}/token${url.search}`, { headers }));
  }

  // Other registries: discover the realm by probing the registry's /v2/, then
  // forward the CLIENT's own credentials (if any) so private images work. The
  // proxy never stores credentials — each client authenticates as itself.
  const base = hostRegistry ? registryBase(hostRegistry) : registryBase(service);
  let realm = `${base}/token`;
  try {
    const probe = await fetch(`${base}/v2/`, { headers: { accept: "application/json" } });
    const wa = probe.headers.get("www-authenticate");
    const m = wa && wa.match(/realm="([^"]+)"/i);
    if (m) realm = m[1];
  } catch {
    /* fall back to <base>/token */
  }
  const headers = new Headers({ accept: "application/json" });
  if (clientAuth) headers.set("authorization", clientAuth);
  const sep = realm.includes("?") ? "&" : "?";
  const tokenUrl = `${realm}${sep}${url.search.replace(/^\?/, "")}`;
  return forward(await fetch(tokenUrl, { headers }));
}

async function proxyV2(request, url, route, path) {
  const target = route.upstream + path + url.search;
  const isBlob =
    (request.method === "GET" || request.method === "HEAD") && /\/blobs\/[^/]+$/.test(path);
  const passThroughBlob = isBlob && route.blobMode === "redirect";

  const init = {
    method: request.method,
    headers: filterRequestHeaders(request.headers),
    // stream mode: follow the blob 307 to the CDN and stream bytes through us
    // (fetch drops Authorization on the cross-origin hop, so no token leaks to
    // the CDN). redirect mode: don't follow — hand the CDN redirect back to the
    // client so layer bytes never traverse (or meter) this function.
    redirect: passThroughBlob ? "manual" : "follow",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  const resp = await fetch(target, init);

  // Blob pass-through: relay the upstream CDN redirect to the client untouched.
  // (If the upstream serves the blob directly with 2xx, fall through and stream.)
  if (passThroughBlob && resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
    return new Response(null, {
      status: resp.status,
      headers: { location: new URL(resp.headers.get("location"), target).toString() },
    });
  }

  if (resp.status === 401 && resp.headers.has("www-authenticate")) {
    const headers = buildResponseHeaders(resp.headers);
    headers.set("www-authenticate", rewriteAuthenticate(resp.headers.get("www-authenticate"), url.origin));
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }

  return forward(resp);
}

export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);
  const { pathname, search } = url;

  const cfg = {
    registry: env.UPSTREAM_REGISTRY || DEFAULTS.registry,
    auth: env.UPSTREAM_AUTH || DEFAULTS.auth,
    service: env.UPSTREAM_SERVICE || DEFAULTS.service,
  };
  cfg.libraryRedirect =
    env.LIBRARY_REDIRECT != null
      ? !["0", "false", "off"].includes(String(env.LIBRARY_REDIRECT).toLowerCase())
      : isDockerHub(cfg.registry);
  cfg.blobMode = env.BLOB_MODE === "redirect" ? "redirect" : "stream";

  // Subdomain mode: the host pins the whole request to one upstream registry.
  const hostRegistry = registryFromHost(url.host, env);
  const clientAuth = request.headers.get("authorization");

  if (pathname === "/") {
    return new Response(landingPage(url.host), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Our rewritten token realm lands here. Forward the client's own credentials
  // (private pulls) and the host-pinned registry (subdomain mode).
  if (pathname === "/v2/auth") {
    return handleToken(url, env, clientAuth, hostRegistry);
  }

  // Registry v2 base ping. On a registry subdomain, proxy to THAT registry so
  // `docker login <subdomain>` gets the right challenge/service.
  if (pathname === "/v2/") {
    const upstream = hostRegistry ? registryBase(hostRegistry) : cfg.registry;
    return proxyV2(request, url, { upstream, blobMode: cfg.blobMode }, "/v2/");
  }

  if (pathname.startsWith("/v2/")) {
    // SUBDOMAIN MODE: the whole host is one registry; no path-prefix parsing.
    if (hostRegistry) {
      const upstream = registryBase(hostRegistry);
      if (isDockerHub(hostRegistry)) {
        const redir = libraryExpand(url, pathname, search);
        if (redir) return redir;
      }
      return proxyV2(request, url, { upstream, blobMode: cfg.blobMode }, pathname);
    }

    // APEX MODE: explicit registry via dotted first segment, else Docker Hub.
    const parts = pathname.split("/"); // ["", "v2", <seg>, ...]
    const first = parts[2];
    if (first && first.includes(".")) {
      if (!isRegistryHost(first, env)) {
        return new Response(
          `Registry not allowed: ${first}\nAllowed: ${[...allowedRegistries(env)].join(", ")}\nAdd more via the EXTRA_REGISTRIES env var.\n`,
          { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
      const strippedPath = "/v2/" + parts.slice(3).join("/");
      return proxyV2(request, url, { upstream: registryBase(first), blobMode: cfg.blobMode }, strippedPath);
    }

    if (cfg.libraryRedirect) {
      const redir = libraryExpand(url, pathname, search);
      if (redir) return redir;
    }
    return proxyV2(request, url, { upstream: cfg.registry, blobMode: cfg.blobMode }, pathname);
  }

  return new Response("Not Found", { status: 404 });
}

function landingPage(host) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>redocker</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#222}code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow:auto}</style>
</head><body>
<h1>redocker</h1>
<p>A multi-registry Docker pull-through mirror running on Vercel.</p>
<h3>Docker Hub — use as a registry mirror</h3>
<pre>// /etc/docker/daemon.json
{
  "registry-mirrors": ["https://${host}"]
}</pre>
<h3>Public images — pull by prefix</h3>
<pre>docker pull ${host}/library/nginx          # Docker Hub (auto library/)
docker pull ${host}/ghcr.io/cli/cli        # any allowed registry</pre>
<h3>Private images — log in to a registry subdomain</h3>
<pre>docker login ghcr.${host} -u USER --password-stdin   # paste a read:packages PAT
docker pull  ghcr.${host}/owner/private-image:tag</pre>
</body></html>`;
}
