// redocker — Docker Registry v2 pull-through proxy core.
//
// Web-standard APIs only (fetch / Request / Response / URL / ReadableStream),
// so the exact same module runs on Vercel Edge runtime AND on Node 18+ (for
// local testing). No Node- or Cloudflare-specific globals.
//
// Supported flow (docker pull):
//   GET /v2/                      -> 401 challenge, realm rewritten to /v2/auth
//   GET /v2/auth?scope&service    -> token, forwarded to auth.docker.io
//   GET /v2/<name>/manifests/<r>  -> manifest (incl. multi-arch index)
//   GET /v2/<name>/blobs/<digest> -> blob, streamed through (307 followed)
//   /v2/<single-name>/...         -> 301 to /v2/library/<single-name>/...

const DEFAULTS = {
  registry: "https://registry-1.docker.io",
  auth: "https://auth.docker.io",
  service: "registry.docker.io",
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

// Request headers we never forward upstream.
const DROP_REQUEST_HEADERS = new Set(["host", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-vercel-id", "x-vercel-deployment-url", "x-vercel-forwarded-for"]);

function isDockerHub(registry) {
  return registry.includes("registry-1.docker.io") || registry.includes("docker.io");
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

// Rewrite `realm="https://auth.docker.io/token"` -> our own token endpoint so
// the docker client comes back to us for the token instead of hitting Docker
// directly (which may be blocked / lets us inject our own credentials).
function rewriteAuthenticate(value, origin) {
  return value.replace(/realm="[^"]*"/i, `realm="${origin}/v2/auth"`);
}

async function handleToken(url, cfg, env) {
  let query = url.search; // e.g. "?service=...&scope=repository:library/nginx:pull"
  if (!/[?&]service=/.test(query)) {
    query += (query ? "&" : "?") + "service=" + encodeURIComponent(cfg.service);
  }
  const tokenUrl = `${cfg.auth}/token${query}`;

  const headers = new Headers({ accept: "application/json" });
  // Optional: authenticate the token request with YOUR Docker Hub account so
  // pulls count against your (higher) rate-limit bucket instead of the shared
  // anonymous-per-IP bucket that all Vercel egress traffic shares.
  if (env.DOCKER_USERNAME && env.DOCKER_PASSWORD) {
    headers.set("authorization", "Basic " + btoa(`${env.DOCKER_USERNAME}:${env.DOCKER_PASSWORD}`));
  }

  const resp = await fetch(tokenUrl, { headers });
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: buildResponseHeaders(resp.headers),
  });
}

async function proxyV2(request, url, cfg, path) {
  const target = cfg.registry + path + url.search;
  const isBlob =
    (request.method === "GET" || request.method === "HEAD") && /\/blobs\/[^/]+$/.test(path);
  const passThroughBlob = isBlob && cfg.blobMode === "redirect";

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

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: buildResponseHeaders(resp.headers),
  });
}

export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);
  const { pathname, search } = url;

  const cfg = {
    registry: env.UPSTREAM_REGISTRY || DEFAULTS.registry,
    auth: env.UPSTREAM_AUTH || DEFAULTS.auth,
    service: env.UPSTREAM_SERVICE || DEFAULTS.service,
  };
  // Whether to expand single-name images to library/<name> (Docker Hub's
  // official-image convention). Auto-on for Docker Hub; override via env for
  // Docker-Hub-compatible mirrors.
  cfg.libraryRedirect =
    env.LIBRARY_REDIRECT != null
      ? !["0", "false", "off"].includes(String(env.LIBRARY_REDIRECT).toLowerCase())
      : isDockerHub(cfg.registry);
  // Blob delivery strategy:
  //   "stream"   (default) — follow the registry's 307 to the CDN and stream
  //              the layer bytes THROUGH this function. Truly accelerates, but
  //              every byte counts against Vercel's 100GB/mo egress.
  //   "redirect" — hand the CDN 307 back to the client so layer bytes go
  //              client<->CDN directly and never meter Vercel. Saves bandwidth;
  //              only helps if the client can reach the CDN.
  cfg.blobMode = env.BLOB_MODE === "redirect" ? "redirect" : "stream";

  if (pathname === "/") {
    return new Response(landingPage(url.host), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Our rewritten token realm lands here.
  if (pathname === "/v2/auth") {
    return handleToken(url, cfg, env);
  }

  // Registry v2 base ping.
  if (pathname === "/v2/") {
    return proxyV2(request, url, cfg, "/v2/");
  }

  if (pathname.startsWith("/v2/")) {
    // Docker Hub official-image namespace expansion: a custom-prefix pull of
    // `mydomain/nginx` arrives as /v2/nginx/manifests/<ref> (5 path segments).
    // Real namespaced repos (/v2/ns/repo/...) have 6+. Redirect single-name
    // images to library/<name> so `docker pull mydomain/nginx` works.
    if (cfg.libraryRedirect) {
      const parts = pathname.split("/"); // ["", "v2", <name>, <verb>, ...]
      const verbs = ["manifests", "blobs", "tags"];
      if (parts.length === 5 && verbs.includes(parts[3]) && parts[2] !== "library") {
        parts.splice(2, 0, "library");
        return Response.redirect(`${url.origin}${parts.join("/")}${search}`, 301);
      }
    }
    return proxyV2(request, url, cfg, pathname);
  }

  return new Response("Not Found", { status: 404 });
}

function landingPage(host) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>redocker</title>
<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#222}code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow:auto}</style>
</head><body>
<h1>redocker</h1>
<p>A Docker Hub pull-through mirror running on Vercel Edge.</p>
<h3>Use as a registry mirror</h3>
<pre>// /etc/docker/daemon.json
{
  "registry-mirrors": ["https://${host}"]
}</pre>
<p>Then restart docker and <code>docker pull nginx</code> goes through this mirror.</p>
<h3>Or pull by prefix</h3>
<pre>docker pull ${host}/library/nginx:latest
docker pull ${host}/nginx        # auto-expands to library/nginx</pre>
</body></html>`;
}
