// Fixed speed cameras for POST /v1/routes: reads osmium's OPL export of the OpenStreetMap `highway=speed_camera` nodes
// and the roads (ways with a highway tag) they are vertices of (exported by build.sh; install.sh runs this script), and
// loads each camera as the directed node pairs arriving at it into the API's speed_cameras table through POST
// /v1/admin/speedCameras (the first request replaces the stored set).
//
// A camera arrived at along a road from its previous node and from its next one, both ways, unless it is tagged
// direction=forward or direction=backward (relative to that road). A numeric or compass direction is the way the camera
// faces, which does not say which traffic it measures, so it counts both ways. Its limit is its own numeric maxspeed
// ("50", or "30 mph" converted; 5..160 km/h), null otherwise. Cameras mapped beside the road (not one of its vertices)
// and enforcement relations (average-speed sections) are not loaded.
//
// Usage: ADMIN_TOKEN=… node speedcameras.mjs <speedcameras.opl> [apiBase]
//        node speedcameras.mjs <speedcameras.opl> --dry-run     (prints counts and a sample, loads nothing)
// apiBase defaults to http://127.0.0.1:8787. Data: © OpenStreetMap contributors, ODbL 1.0.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const CHUNK = 5000; // cameras per request, the endpoint's limit
const MIN_KMH = 5;
const MAX_KMH = 160;

const [file, target = "http://127.0.0.1:8787"] = process.argv.slice(2);
if (!file) {
  console.error("usage: ADMIN_TOKEN=… node speedcameras.mjs <speedcameras.opl> [apiBase | --dry-run]");
  process.exit(2);
}
const dryRun = target === "--dry-run";
const token = process.env.ADMIN_TOKEN;
if (!dryRun && !token) {
  console.error("ADMIN_TOKEN is not set");
  process.exit(2);
}

/** A maxspeed value in km/h, or null when it is not a numeric limit within MIN_KMH..MAX_KMH. */
function kmh(value) {
  if (value == null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?\s*$/.exec(value);
  if (!m) return null;
  const v = Math.round(Number(m[1]) * (m[2] === "mph" ? 1.609344 : 1));
  return v >= MIN_KMH && v <= MAX_KMH ? v : null;
}

// OPL escapes characters other than letters, digits and a few safe ones as %<hex code point>%.
const unescape = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

/** An OPL node or way line as {kind, id, tags, nodes}; null for anything else. */
function parse(line) {
  const kind = line[0];
  if (kind !== "n" && kind !== "w") return null;
  let tags = {};
  let nodes = [];
  const fields = line.split(" ");
  for (const field of fields.slice(1)) {
    if (field.startsWith("T") && field.length > 1) {
      tags = Object.fromEntries(field.slice(1).split(",").map((kv) => {
        const i = kv.indexOf("=");
        return [unescape(kv.slice(0, i)), unescape(kv.slice(i + 1))];
      }));
    } else if (kind === "w" && field.startsWith("N") && field.length > 1) {
      nodes = field.slice(1).split(",").map((n) => Number(n.slice(1)));
    }
  }
  return { kind, id: Number(fields[0].slice(1)), tags, nodes };
}

const cameras = new Map(); // node id → {kmh, direction: "forward" | "backward" | null}
const placed = new Set();
let roads = 0;
let withLimit = 0;
let faced = 0;
const pairs = new Map(); // "a:b" → [a, b, kmh]

for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
  const item = parse(line);
  if (!item) continue;
  const { kind, id, tags, nodes } = item;
  if (kind === "n") {
    if (tags.highway !== "speed_camera" || !Number.isSafeInteger(id) || id <= 0) continue;
    const limit = kmh(tags.maxspeed);
    if (limit != null) withLimit++;
    const direction = tags.direction === "forward" || tags.direction === "backward" ? tags.direction : null;
    if (tags.direction != null && direction == null) faced++;
    cameras.set(id, { kmh: limit, direction });
    continue;
  }
  if (!tags.highway || nodes.some((n) => !Number.isSafeInteger(n) || n <= 0)) continue;
  roads++;
  nodes.forEach((c, i) => {
    const camera = cameras.get(c);
    if (!camera) return;
    const add = (from) => {
      if (from === undefined || from === c) return;
      pairs.set(`${from}:${c}`, [from, c, camera.kmh]);
      placed.add(c);
    };
    if (camera.direction !== "backward") add(nodes[i - 1]);
    if (camera.direction !== "forward") add(nodes[i + 1]);
  });
}

const rows = [...pairs.values()];
let stored = 0;
if (!dryRun) {
  for (let i = 0; i === 0 || i < rows.length; i += CHUNK) {
    const res = await fetch(`${target.replace(/\/+$/, "")}/v1/admin/speedCameras`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ replace: i === 0, cameras: rows.slice(i, i + CHUNK) }),
    });
    if (!res.ok) {
      console.error(`POST /v1/admin/speedCameras failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    stored = (await res.json()).total;
  }
}
console.log(`${cameras.size} cameras (${withLimit} with a numeric limit, ${faced} with a facing direction counted both ways), ` +
  `${placed.size} on ${roads} roads, ${rows.length} approaches` + (dryRun ? "" : `; the API now holds ${stored}`));
if (dryRun) console.log(JSON.stringify(rows.slice(0, 5)));
