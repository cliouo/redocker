// Deterministic multi-registry routing test. Mocks global fetch so we can assert
// EXACTLY which upstream URL the proxy calls for each request shape — no network,
// no flaky public images.
import { handleRequest } from "../src/proxy.js";

const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  calls.push({ url, headers: init.headers });
  if (url.endsWith("/v2/")) {
    return new Response("{}", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="https://auth.probe/token",service="probed"' },
    });
  }
  if (url.includes("/token") || url.includes("/v2/auth")) {
    return new Response(JSON.stringify({ token: "mock" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("mock-body", {
    status: 200,
    headers: { "content-type": "application/octet-stream", "docker-content-digest": "sha256:abc" },
  });
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const fetched = (u) => calls.some((c) => c.url === u);
const urls = () => JSON.stringify(calls.map((c) => c.url));
const authOf = (u) => {
  const c = calls.find((x) => x.url.startsWith(u));
  return c && new Headers(c.headers || {}).get("authorization");
};
const ENV = { DOCKER_USERNAME: "u", DOCKER_PASSWORD: "p" };
const G = (p) => new Request("https://proxy.test" + p, { headers: { authorization: "Bearer x" } });

calls = []; await handleRequest(G("/v2/ghcr.io/owner/img/manifests/abc"), ENV);
check("ghcr.io prefix routes+strips", fetched("https://ghcr.io/v2/owner/img/manifests/abc"), urls());

calls = []; await handleRequest(G("/v2/quay.io/prometheus/busybox/manifests/latest"), ENV);
check("quay.io prefix routes+strips", fetched("https://quay.io/v2/prometheus/busybox/manifests/latest"), urls());

calls = []; await handleRequest(G("/v2/registry.k8s.io/pause/manifests/3.9"), ENV);
check("registry.k8s.io prefix routes+strips", fetched("https://registry.k8s.io/v2/pause/manifests/3.9"), urls());

calls = []; await handleRequest(G("/v2/us-docker.pkg.dev/proj/repo/img/manifests/x"), ENV);
check("*.pkg.dev suffix allowed", fetched("https://us-docker.pkg.dev/v2/proj/repo/img/manifests/x"), urls());

calls = []; let r = await handleRequest(G("/v2/nginx/manifests/latest"), ENV);
check("docker hub single-name -> 301", r.status === 301, "status " + r.status);
check("  ...Location adds library/", (r.headers.get("location") || "").endsWith("/v2/library/nginx/manifests/latest"), r.headers.get("location"));

calls = []; await handleRequest(G("/v2/library/nginx/manifests/latest"), ENV);
check("docker hub library/ -> registry-1.docker.io", fetched("https://registry-1.docker.io/v2/library/nginx/manifests/latest"), urls());

calls = []; await handleRequest(G("/v2/bitnami/nginx/manifests/latest"), ENV);
check("docker hub user/repo -> no library rewrite", fetched("https://registry-1.docker.io/v2/bitnami/nginx/manifests/latest"), urls());

calls = []; r = await handleRequest(G("/v2/evil.com/x/manifests/y"), ENV);
check("disallowed dotted host -> 404", r.status === 404, "status " + r.status);
check("  ...and never fetched", !calls.some((c) => c.url.includes("evil.com")), urls());

calls = []; await handleRequest(G("/v2/evil.com/x/manifests/y"), { ...ENV, EXTRA_REGISTRIES: "evil.com" });
check("EXTRA_REGISTRIES allowlists a host", fetched("https://evil.com/v2/x/manifests/y"), urls());

calls = []; await handleRequest(new Request("https://proxy.test/v2/auth?service=registry.docker.io&scope=repository:library/nginx:pull"), ENV);
check("token(docker hub) -> auth.docker.io/token", calls.some((c) => c.url.startsWith("https://auth.docker.io/token")), urls());
check("token(docker hub) -> Basic PAT injected", (authOf("https://auth.docker.io/token") || "").startsWith("Basic "), "no basic");

calls = []; await handleRequest(new Request("https://proxy.test/v2/auth?service=ghcr.io&scope=repository:owner/img:pull"), ENV);
check("token(ghcr) -> probes https://ghcr.io/v2/", fetched("https://ghcr.io/v2/"), urls());
check("token(ghcr) -> uses discovered realm", calls.some((c) => c.url.startsWith("https://auth.probe/token")), urls());
check("token(ghcr) -> does NOT leak docker creds", !authOf("https://auth.probe/token"), "leaked Basic to other registry");

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nmulti-registry: ALL PASS" : `\nmulti-registry: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
