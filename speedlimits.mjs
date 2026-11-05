// Posted speed limits for POST /v1/routes: reads osmium's OPL export of the OpenStreetMap ways tagged maxspeed,
// maxspeed:forward or maxspeed:backward (exported by build.sh; install.sh runs this script), and loads one limit per
// directed pair of consecutive nodes into the API's speed_limits table through POST /v1/admin/speedLimits (the first
// request replaces the stored set).
//
// Only roads (a highway tag) with a numeric limit: "50" km/h, or "30 mph" converted. Implicit limits (TR:urban,
// TR:rural, TR:motorway), "none", "signals", "walk" and the like are skipped: what they mean depends on the vehicle
// class, and a limit is never guessed. maxspeed:forward / maxspeed:backward override maxspeed for their direction. A
// one-way road (oneway=yes, or a motorway or roundabout without oneway=no) gets its direction of travel only; oneway=-1
// the reverse.
//
// Usage: ADMIN_TOKEN=… node speedlimits.mjs <speedlimits.opl> [apiBase]
//        node speedlimits.mjs <speedlimits.opl> --dry-run     (prints counts and a sample, loads nothing)
// apiBase defaults to http://127.0.0.1:8787. Data: © OpenStreetMap contributors, ODbL 1.0.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const CHUNK = 5000; // limits per request, the endpoint's limit
const MIN_KMH = 5;
const MAX_KMH = 160;

const [file, target = "http://127.0.0.1:8787"] = process.argv.slice(2);
if (!file) {
  console.error("usage: ADMIN_TOKEN=… node speedlimits.mjs <speedlimits.opl> [apiBase | --dry-run]");
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

function parseWay(line) {
  if (!line.startsWith("w")) return null;
  let tags = {};
  let nodes = [];
  for (const field of line.split(" ")) {
    if (field.startsWith("T") && field.length > 1) {
      tags = Object.fromEntries(field.slice(1).split(",").map((kv) => {
        const i = kv.indexOf("=");
        return [unescape(kv.slice(0, i)), unescape(kv.slice(i + 1))];
      }));
    } else if (field.startsWith("N") && field.length > 1) {
      nodes = field.slice(1).split(",").map((n) => Number(n.slice(1)));
    }
  }
  return { tags, nodes };
}

let ways = 0;
let roads = 0;
let numeric = 0;
let pairs = 0;
let stored = 0;
let first = true;
const skipped = new Map();
let batch = [];

async function flush() {
  if (dryRun || (batch.length === 0 && !first)) {
    batch = [];
    return;
  }
  const res = await fetch(`${target.replace(/\/+$/, "")}/v1/admin/speedLimits`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ replace: first, limits: batch }),
  });
  if (!res.ok) {
    console.error(`POST /v1/admin/speedLimits failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  stored = (await res.json()).total;
  first = false;
  batch = [];
}

const sample = [];
for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
  const way = parseWay(line);
  if (!way) continue;
  ways++;
  const { tags, nodes } = way;
  if (!tags.highway || nodes.length < 2 || nodes.some((n) => !Number.isSafeInteger(n) || n <= 0)) continue;
  roads++;
  const forward = kmh(tags["maxspeed:forward"] ?? tags.maxspeed);
  const backward = kmh(tags["maxspeed:backward"] ?? tags.maxspeed);
  if (forward == null && backward == null) {
    const v = tags.maxspeed ?? tags["maxspeed:forward"] ?? tags["maxspeed:backward"];
    skipped.set(v, (skipped.get(v) ?? 0) + 1);
    continue;
  }
  numeric++;
  const oneway = tags.oneway;
  const reverseOnly = oneway === "-1" || oneway === "reverse";
  const forwardOnly = !reverseOnly && (["yes", "true", "1"].includes(oneway) ||
    (oneway !== "no" && (tags.highway === "motorway" || tags.junction === "roundabout")));
  for (let i = 1; i < nodes.length; i++) {
    const [a, b] = [nodes[i - 1], nodes[i]];
    if (a === b) continue;
    if (forward != null && !reverseOnly) batch.push([a, b, forward]);
    if (backward != null && !forwardOnly) batch.push([b, a, backward]);
  }
  if (sample.length < 5) sample.push({ maxspeed: tags.maxspeed, highway: tags.highway, oneway, pairs: batch.slice(-2) });
  while (batch.length >= CHUNK) {
    const rest = batch.slice(CHUNK);
    batch = batch.slice(0, CHUNK);
    pairs += batch.length;
    await flush();
    batch = rest;
  }
}
pairs += batch.length;
await flush();

const top = [...skipped.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([v, n]) => `${v}: ${n}`).join(", ");
console.log(`${ways} ways, ${roads} roads, ${numeric} with a numeric limit, ${pairs} node pairs` +
  (dryRun ? "" : `; the API now holds ${stored}`));
if (top) console.log(`skipped (not numeric): ${top}`);
if (dryRun) console.log(JSON.stringify(sample));
