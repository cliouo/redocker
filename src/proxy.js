// redocker — Docker Registry v2 pull-through proxy core.
//
// Web-standard APIs only (fetch / Request / Response / URL / ReadableStream),
// so the exact same module runs on Vercel Edge runtime AND on Node 18+ (for
// local testing). No Node- or Cloudflare-specific globals.
//
// Routing
//   /v2/                          -> 401 challenge, realm rewritten to /v2/auth
//   /v2/auth?scope&service        -> token (Docker Hub: known realm + your PAT;
//                                    other registries: realm discovered by probe)
//   /v2/<name>/...                -> Docker Hub (single name auto-expands to library/)
//   /v2/<registry-host>/<repo>/.. -> that registry, e.g. /v2/ghcr.io/owner/img/...
//                                    (Docker Hub namespaces never contain a dot,
//                                    so a dotted first segment = explicit registry)

const DEFAULTS = {
  registry: "https://registry-1.docker.io",
  auth: "https://auth.docker.io",
  service: "registry.docker.io",
};

// Registries reachable via the /v2/<host>/... path prefix. An allowlist (not
// "any host") so the deployment isn't an open proxy that strangers can point at
// arbitrary origins to burn your Vercel bandwidth. Extend via EXTRA_REGISTRIES.
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
// Suffix matches (e.g. Google Artifact Registry regional hosts us-docker.pkg.dev).
const ALLOWED_SUFFIXES = [".pkg.dev"];

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

// Request headers we never forward upstream.
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

async function handleToken(url, env) {
  const service = url.searchParams.get("service") || DEFAULTS.service;

  // Docker Hub: realm is known. Inject the owner's PAT so pulls are attributed
  // to their account's rate-limit bucket instead of Vercel's shared egress IP.
  if (service === DEFAULTS.service || service === "docker.io") {
    const authBase = env.UPSTREAM_AUTH || DEFAULTS.auth;
    const headers = new Headers({ accept: "application/json" });
    if (env.DOCKER_USERNAME && env.DOCKER_PASSWORD) {
      headers.set("authorization", "Basic " + btoa(`${env.DOCKER_USERNAME}:${env.DOCKER_PASSWORD}`));
    }
    return forward(await fetch(`${authBase}/token${url.search}`, { headers }));
  }

  // Other registries: discover the realm by probing the registry's /v2/, then
  // request an anonymous token from it (each registry uses a different token
  // path — ghcr /token, quay /v2/auth, ecr /token/ — so we don't hardcode).
  const base = registryBase(service);
  let realm = `${base}/token`;
  try {
    const probe = await fetch(`${base}/v2/`, { headers: { accept: "application/json" } });
    const wa = probe.headers.get("www-authenticate");
    const m = wa && wa.match(/realm="([^"]+)"/i);
    if (m) realm = m[1];
  } catch {
    /* fall back to <base>/token */
  }
  const sep = realm.includes("?") ? "&" : "?";
  const tokenUrl = `${realm}${sep}${url.search.replace(/^\?/, "")}`;
  return forward(await fetch(tokenUrl, { headers: { accept: "application/json" } }));
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
  // Expand single-name images to library/<name> (Docker Hub official-image
  // convention). Auto-on for Docker Hub; override via env for compatible mirrors.
  cfg.libraryRedirect =
    env.LIBRARY_REDIRECT != null
      ? !["0", "false", "off"].includes(String(env.LIBRARY_REDIRECT).toLowerCase())
      : isDockerHub(cfg.registry);
  // Blob delivery: "stream" (default, real acceleration, uses Vercel egress) or
  // "redirect" (hand the CDN 307 to the client, saves bandwidth).
  cfg.blobMode = env.BLOB_MODE === "redirect" ? "redirect" : "stream";

  if (pathname === "/") {
    return new Response(landingPage(url.host), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Our rewritten token realm lands here (any upstream).
  if (pathname === "/v2/auth") {
    return handleToken(url, env);
  }

  // Registry v2 base ping (registry-agnostic; proxy to Docker Hub for the challenge).
  if (pathname === "/v2/") {
    return proxyV2(request, url, { upstream: cfg.registry, blobMode: cfg.blobMode }, "/v2/");
  }

  if (pathname.startsWith("/v2/")) {
    const parts = pathname.split("/"); // ["", "v2", <seg>, ...]
    const first = parts[2];

    // Explicit registry via dotted first segment: /v2/ghcr.io/owner/img/...
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

    // Default: Docker Hub, with library/ auto-expansion for single-name images.
    if (cfg.libraryRedirect) {
      const verbs = ["manifests", "blobs", "tags"];
      if (parts.length === 5 && verbs.includes(parts[3]) && parts[2] !== "library") {
        parts.splice(2, 0, "library");
        return Response.redirect(`${url.origin}${parts.join("/")}${search}`, 301);
      }
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
<p>Then <code>docker pull nginx</code> goes through this mirror.</p>
<h3>Any registry — pull by prefix</h3>
<pre>docker pull ${host}/library/nginx          # Docker Hub (auto library/)
docker pull ${host}/ghcr.io/cli/cli        # GitHub Container Registry
docker pull ${host}/quay.io/prometheus/busybox
docker pull ${host}/registry.k8s.io/pause:3.9</pre>
</body></html>`;
}
