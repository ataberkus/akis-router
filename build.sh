#!/bin/bash
# Builds Akış's router data for all of Türkiye: OSRM v6 (car profile, MLD) from Geofabrik's Türkiye extract, plus the
# motorway carriageways behind POST /v1/routes' motorway option. Run where memory is plentiful (the osrm.yml workflow of
# the public repo ataberkus/akis-router, which holds a copy of this script, on a GitHub runner; osrm-extract needs several GB, more than the 2 GB VPS has), then ship the output to the VPS's
# install.sh, which serves it.
#
# Usage: bash build.sh <out-dir>     (needs Docker, osmium-tool and ~15 GB of free disk next to $WORK, default /var/tmp)
# Output in <out-dir>: akis.osrm.* (the router data), motorways.geojsonseq (osmium export of every highway=motorway
# way), speedlimits.opl (every way tagged maxspeed, maxspeed:forward or maxspeed:backward, with its node ids) and
# speedcameras.opl (every highway=speed_camera node and the roads it is a vertex of): data only, install.sh refuses
# anything else; the scripts that load these into the API live on the VPS. closed-ways.txt, next to this script,
# lists ways the car profile drops: roads closed in reality that OpenStreetMap still has open.
# Data: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright), via Geofabrik.
set -euo pipefail

IMAGE=ghcr.io/project-osrm/osrm-backend:v6.0.0
out=${1:?usage: bash build.sh <out-dir>}
here=$(cd "$(dirname "$0")" && pwd)
install -d "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d -p "${WORK:-/var/tmp}" akis-osrm.XXXXXX)
trap 'rm -rf "$work"' EXIT

# The extract, checked against the MD5 Geofabrik publishes beside it (curl -f: an HTTP error fails the build).
curl -fsSL -o "$work/akis.osm.pbf" https://download.geofabrik.de/europe/turkey-latest.osm.pbf
md5=$(curl -fsSL https://download.geofabrik.de/europe/turkey-latest.osm.pbf.md5 | awk 'NR == 1 { print $1 }')
[[ $md5 =~ ^[0-9a-f]{32}$ ]] || { echo "no MD5 published for the extract" >&2; exit 1; }
echo "$md5  $work/akis.osm.pbf" | md5sum -c --quiet -

# The stock car profile, with every combination of toll/motorway/ferry excludable (the app may avoid several at once).
docker pull -q "$IMAGE"
docker run --rm "$IMAGE" cat /opt/car.lua > "$work/akis-car.lua"
perl -0pi -e "s/excludable = Sequence \{.*?\n    \},/excludable = Sequence {\n        Set {'toll'},\n        Set {'motorway'},\n        Set {'ferry'},\n        Set {'toll', 'motorway'},\n        Set {'toll', 'ferry'},\n        Set {'motorway', 'ferry'},\n        Set {'toll', 'motorway', 'ferry'}\n    },/s" "$work/akis-car.lua"
grep -q "Set {'toll', 'motorway', 'ferry'}" "$work/akis-car.lua"
# Roads closed in reality that OpenStreetMap still has open: process_way returns before routing them.
closed=$(awk '{ sub(/\r$/, ""); sub(/#.*/, "") } $1 ~ /^[0-9]+$/ { printf "%s[%s]=true", n++ ? "," : "", $1 }' "$here/closed-ways.txt")
perl -0pi -e "s/^(function process_way\(profile, way, result, relations\)\n)/local akis_closed_ways = {$closed}\n\$1  if akis_closed_ways[way:id()] then return end\n/m" "$work/akis-car.lua"
grep -q "if akis_closed_ways\[way:id()\] then return end" "$work/akis-car.lua"
# car.lua loads its helpers from lib/ next to it.
docker run --rm -v "$work:/build" "$IMAGE" cp -r /opt/lib /build/lib

run() { docker run --rm -v "$work:/build" "$IMAGE" "$@"; }
run osrm-extract -p /build/akis-car.lua /build/akis.osm.pbf
run osrm-partition /build/akis.osrm
run osrm-customize /build/akis.osrm

osmium tags-filter "$work/akis.osm.pbf" w/highway=motorway -o "$work/motorways.osm.pbf"
osmium export "$work/motorways.osm.pbf" --geometry-types=linestring -f geojsonseq -o "$work/motorways.geojsonseq"
# Node ids only (-R: no node records): the API maps OSRM's node annotation onto consecutive pairs.
osmium tags-filter "$work/akis.osm.pbf" w/maxspeed w/maxspeed:forward w/maxspeed:backward -R -o "$work/maxspeed.osm.pbf"
osmium cat "$work/maxspeed.osm.pbf" -f opl,add_metadata=false -o "$work/speedlimits.opl"
# Speed cameras with the roads they are vertices of (-R: those ways' other nodes are ids only).
osmium tags-filter "$work/akis.osm.pbf" n/highway=speed_camera -o "$work/cameras.osm.pbf"
osmium getparents "$work/akis.osm.pbf" -I "$work/cameras.osm.pbf" --add-self -o "$work/camera-parents.osm.pbf"
osmium tags-filter "$work/camera-parents.osm.pbf" n/highway=speed_camera w/highway -R -o "$work/camera-roads.osm.pbf"
osmium cat "$work/camera-roads.osm.pbf" -f opl,add_metadata=false -o "$work/speedcameras.opl"

rm -f "$out"/akis.osrm* "$out/motorways.geojsonseq" "$out/motorways.mjs" "$out/speedlimits.opl" "$out/speedlimits.mjs" \
  "$out/speedcameras.opl" "$out/speedcameras.mjs"
mv "$work"/akis.osrm* "$work/motorways.geojsonseq" "$work/speedlimits.opl" "$work/speedcameras.opl" "$out/"
du -sh "$out"
