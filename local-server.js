// Local test harness: serves the proxy over plain HTTP using Node's http
// server, so we can exercise the full Docker Registry v2 flow with curl —
// without docker or the Vercel CLI installed. Uses the SAME node-adapter the
// deployed Vercel function uses, so local tests validate the real code path.
//
//   node local-server.js          # listens on :8787
//   PORT=9000 node local-server.js

import { createServer } from "node:http";
import { handleNode, readEnv } from "./src/node-adapter.js";

const PORT = Number(process.env.PORT || 8787);
const env = readEnv();

createServer((req, res) => handleNode(req, res, env)).listen(PORT, () => {
  console.log(`redocker local proxy listening on http://localhost:${PORT}`);
});
