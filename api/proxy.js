// Vercel serverless function (Node.js runtime — the platform default; Edge is
// on a deprecation path). All paths route here via the catch-all rewrite in
// vercel.json. Streaming the response (pipe to res) is exempt from the 4.5MB
// body limit, so blob layers of any size can flow through in stream mode.
import { handleNode, readEnv } from "../src/node-adapter.js";

// Hobby plan allows up to 300s; large layers over slow links need the headroom.
export const config = { maxDuration: 300 };

const env = readEnv();

export default function handler(req, res) {
  return handleNode(req, res, env);
}
