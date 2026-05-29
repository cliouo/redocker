// Bridges Node's (req, res) HTTP model to the Web-standard handleRequest core,
// streaming the response body. Used by BOTH the local dev server and the Vercel
// Node serverless function, so the deployed code path is exactly what we test.
import { Readable } from "node:stream";
import { handleRequest } from "./proxy.js";

export function readEnv(source = process.env) {
  return {
    DOCKER_USERNAME: source.DOCKER_USERNAME,
    DOCKER_PASSWORD: source.DOCKER_PASSWORD,
    UPSTREAM_REGISTRY: source.UPSTREAM_REGISTRY,
    UPSTREAM_AUTH: source.UPSTREAM_AUTH,
    UPSTREAM_SERVICE: source.UPSTREAM_SERVICE,
    LIBRARY_REDIRECT: source.LIBRARY_REDIRECT,
    BLOB_MODE: source.BLOB_MODE,
  };
}

export async function handleNode(req, res, env) {
  try {
    // Behind Vercel, TLS is terminated at the edge: trust x-forwarded-proto so
    // the rewritten token realm uses the public https origin (the custom
    // domain). Locally (plain http) fall back to the socket state.
    const xfProto = req.headers["x-forwarded-proto"];
    const proto = xfProto
      ? String(xfProto).split(",")[0].trim()
      : req.socket && req.socket.encrypted
        ? "https"
        : "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const reqUrl = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
      else if (v != null) headers.set(k, v);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(reqUrl, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
    });

    const response = await handleRequest(request, env);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (err) {
    if (!res.headersSent) res.statusCode = 502;
    res.end("redocker proxy error: " + (err && err.stack ? err.stack : String(err)));
  }
}
