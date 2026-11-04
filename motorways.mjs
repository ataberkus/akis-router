// Motorway points for POST /v1/routes' motorway alternative: reads osmium's GeoJSON-sequence export of OpenStreetMap
// `highway=motorway` ways (exported by build.sh; install.sh runs this script), joins each carriageway's ways into one line, samples a point every 500 m
// with its direction of travel, ref and name, keeps those inside the bounding box and loads them into the API's
// motorway_points table through POST /v1/admin/motorways (the first request replaces the stored set).
//
// Usage: ADMIN_TOKEN=… node motorways.mjs <motorways.geojsonseq> <minLon,minLat,maxLon,maxLat> [apiBase]
//        node motorways.mjs <motorways.geojsonseq> <bbox> --dry-run     (prints the points as JSON, loads nothing)
// apiBase defaults to http://127.0.0.1:8787. Data: © OpenStreetMap contributors, ODbL 1.0.
import { readFileSync } from "node:fs";

const STEP_M = 500;
const CHUNK = 2000; // points per request, the endpoint's limit

const [file, bboxArg, target = "http://127.0.0.1:8787"] = process.argv.slice(2);
const bbox = (bboxArg ?? "").split(",").map(Number);
if (!file || bbox.length !== 4 || bbox.some((x) => !Number.isFinite(x))) {
  console.error("usage: node motorways.mjs <motorways.geojsonseq> <minLon,minLat,maxLon,maxLat> [apiBase | --dry-run]");
  process.exit(2);
}
const [minLon, minLat, maxLon, maxLat] = bbox;

const rad = Math.PI / 180;
const metres = ([lon1, lat1], [lon2, lat2]) => {
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
};
const bearing = ([lon1, lat1], [lon2, lat2]) => {
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return Math.round((Math.atan2(y, x) / rad + 360) % 360) % 360;
};

// One carriageway per way, in its direction of travel. Motorways are one-way unless tagged oneway=no (then both
// directions) or oneway=-1 (drawn against the traffic).
const ways = [];
for (const record of readFileSync(file, "utf8").split(/[\x1e\n]+/)) {
  if (!record.trim()) continue;
  const feature = JSON.parse(record);
  const coords = feature.geometry?.type === "LineString" ? feature.geometry.coordinates : null;
  if (!coords || coords.length < 2) continue;
  const tags = feature.properties ?? {};
  const key = { ref: tags.ref || null, name: tags.name || null };
  if (tags.oneway === "-1") ways.push({ ...key, coords: [...coords].reverse() });
  else ways.push({ ...key, coords });
  if (tags.oneway === "no") ways.push({ ...key, coords: [...coords].reverse() });
}

// Ways of one carriageway follow each other end to start under the same ref (the same name when they have no ref:
// viaducts and tunnels carry names of their own); where exactly one does, the two are one line, so samples stay
// 500 m apart across way boundaries. Each sample keeps the name of the way it lies on.
const at = ([lon, lat]) => `${lon},${lat}`;
const same = (a, b) => (a.ref || b.ref ? a.ref === b.ref : a.name === b.name);
const starting = new Map();
const ending = new Map();
for (const way of ways) {
  starting.set(at(way.coords[0]), [...(starting.get(at(way.coords[0])) ?? []), way]);
  ending.set(at(way.coords.at(-1)), [...(ending.get(at(way.coords.at(-1))) ?? []), way]);
}
const only = (list, way) => {
  const matching = (list ?? []).filter((other) => other !== way && same(other, way));
  return matching.length === 1 ? matching[0] : null;
};
const next = (way) => only(starting.get(at(way.coords.at(-1))), way);
const previous = (way) => only(ending.get(at(way.coords[0])), way);

const used = new Set();
const lines = [];
const follow = (first) => {
  const line = { ref: first.ref, coords: [...first.coords], names: first.coords.map(() => first.name) };
  used.add(first);
  for (let prior = first, way = next(first); way && !used.has(way) && previous(way) === prior; prior = way, way = next(way)) {
    used.add(way);
    line.coords.push(...way.coords.slice(1));
    line.names.push(...way.coords.slice(1).map(() => way.name));
  }
  lines.push(line);
};
for (const way of ways) if (!used.has(way) && !(previous(way) && next(previous(way)) === way)) follow(way);
for (const way of ways) if (!used.has(way)) follow(way); // closed rings

// A point every STEP_M, the first STEP_M / 2 from the line's start; a line shorter than that gets its middle.
const points = [];
for (const { ref, coords, names } of lines) {
  const along = [0];
  for (let i = 1; i < coords.length; i++) along.push(along[i - 1] + metres(coords[i - 1], coords[i]));
  const length = along.at(-1);
  if (length < 100) continue;
  const marks = [];
  for (let m = STEP_M / 2; m <= length; m += STEP_M) marks.push(m);
  if (!marks.length) marks.push(length / 2);
  let i = 1;
  for (const m of marks) {
    while (i < coords.length - 1 && along[i] < m) i++;
    const [a, b] = [coords[i - 1], coords[i]];
    const t = along[i] > along[i - 1] ? (m - along[i - 1]) / (along[i] - along[i - 1]) : 0;
    const lon = a[0] + (b[0] - a[0]) * t, lat = a[1] + (b[1] - a[1]) * t;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    points.push([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, bearing(a, b), ref, names[i]]);
  }
}

if (target === "--dry-run") {
  console.log(JSON.stringify(points));
  process.exit(0);
}
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("ADMIN_TOKEN is not set");
  process.exit(2);
}
let stored = 0;
for (let i = 0; i < points.length || i === 0; i += CHUNK) {
  const res = await fetch(`${target.replace(/\/+$/, "")}/v1/admin/motorways`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ replace: i === 0, points: points.slice(i, i + CHUNK) }),
  });
  if (!res.ok) {
    console.error(`POST /v1/admin/motorways failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  stored = (await res.json()).total;
}
console.log(`${points.length} motorway points from ${lines.length} carriageways loaded; the API now holds ${stored}`);
