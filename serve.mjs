// Minimal static dev server for the website project.
// Serves the project root (the folder this file lives in) at http://localhost:3000.
// Usage:  node serve.mjs            -> serves on port 3000
//         PORT=4000 node serve.mjs  -> serves on port 4000
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

async function resolve(urlPath) {
  // Strip query/hash, decode, and keep the path inside ROOT.
  let rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT.replace(new RegExp(`\\${sep}$`), ""))) return null; // no escaping ROOT
  try {
    const s = await stat(full);
    if (s.isDirectory()) return resolve(rel.replace(/\/?$/, "/"));
    return full;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const file = (await resolve(req.url || "/")) || (await resolve("/index.html"));
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("500 Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
});
