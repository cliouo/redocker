// Validates BLOB_MODE=redirect: when the upstream returns a 307 to a CDN, the
// proxy must relay that redirect to the client untouched (bytes never transit
// the function). Uses a mock upstream so we control the 307 — daocloud serves
// blobs as 200, which only exercises the stream fallback.
import { createServer } from "node:http";
import { handleRequest } from "../src/proxy.js";

const CDN = "https://cdn.example.test/layer/abc?sig=xyz";

const upstream = createServer((req, res) => {
  if (/\/blobs\//.test(req.url)) {
    res.statusCode = 307;
    res.setHeader("location", CDN);
    res.end();
  } else {
    res.statusCode = 200;
    res.end("ok");
  }
});
await new Promise((r) => upstream.listen(0, r));
const port = upstream.address().port;

let failures = 0;
const check = (name, cond, got) => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` (got: ${got})`}`);
  if (!cond) failures++;
};

// redirect mode: expect the 307 relayed to the client
{
  const env = { UPSTREAM_REGISTRY: `http://localhost:${port}`, BLOB_MODE: "redirect" };
  const req = new Request("https://proxy.test/v2/library/nginx/blobs/sha256:deadbeef", {
    headers: { authorization: "Bearer tok" },
  });
  const resp = await handleRequest(req, env);
  check("redirect mode: status is 307", resp.status === 307, resp.status);
  check("redirect mode: Location relayed to CDN", resp.headers.get("location") === CDN, resp.headers.get("location"));
  check("redirect mode: no body (bytes bypass function)", !resp.body, "has body");
}

// stream mode (default): with redirect:follow it would chase the fake CDN and
// fail to connect — proving it does NOT short-circuit to a relayed redirect.
{
  const env = { UPSTREAM_REGISTRY: `http://localhost:${port}` }; // BLOB_MODE defaults to stream
  const req = new Request("https://proxy.test/v2/library/nginx/blobs/sha256:deadbeef", {
    headers: { authorization: "Bearer tok" },
  });
  let threwOrNon307 = false;
  try {
    const resp = await handleRequest(req, env);
    threwOrNon307 = resp.status !== 307; // it followed (and failed to reach fake CDN), not relayed
  } catch {
    threwOrNon307 = true;
  }
  check("stream mode: does NOT relay a 307 (follows instead)", threwOrNon307, "relayed 307");
}

upstream.close();
console.log(failures === 0 ? "\nredirect-mode: ALL PASS" : `\nredirect-mode: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
