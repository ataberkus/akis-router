#!/bin/bash
# Builds Akış's router data for all of Türkiye: OSRM v6 (car profile, MLD) from Geofabrik's Türkiye extract, plus the
# motorway carriageways behind POST /v1/routes' motorway option. Run where memory is plentiful (the osrm.yml workflow
# on a GitHub runner; osrm-extract needs several GB, more than the 2 GB VPS has), then ship the output to the VPS's
# install.sh, which serves it.
#
# Usage: bash build.sh <out-dir>     (needs Docker, osmium-tool and ~15 GB of free disk next to $WORK, default /var/tmp)
# Output in <out-dir>: akis.osrm.* (the router data), motorways.geojsonseq (osmium export of every highway=motorway
# way) and motorways.mjs (loads the points; install.sh runs it).
# Data: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright), via Geofabrik.
set -euo pipefail

IMAGE=ghcr.io/project-osrm/osrm-backend:v6.0.0
out=${1:?usage: bash build.sh <out-dir>}
here=$(cd "$(dirname "$0")" && pwd)
install -d "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d -p "${WORK:-/var/tmp}" akis-osrm.XXXXXX)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/akis.osm.pbf" https://download.geofabrik.de/europe/turkey-latest.osm.pbf

# The stock car profile, with every combination of toll/motorway/ferry excludable (the app may avoid several at once).
docker pull -q "$IMAGE"
docker run --rm "$IMAGE" cat /opt/car.lua > "$work/akis-car.lua"
perl -0pi -e "s/excludable = Sequence \{.*?\n    \},/excludable = Sequence {\n        Set {'toll'},\n        Set {'motorway'},\n        Set {'ferry'},\n        Set {'toll', 'motorway'},\n        Set {'toll', 'ferry'},\n        Set {'motorway', 'ferry'},\n        Set {'toll', 'motorway', 'ferry'}\n    },/s" "$work/akis-car.lua"
grep -q "Set {'toll', 'motorway', 'ferry'}" "$work/akis-car.lua"
# car.lua loads its helpers from lib/ next to it.
docker run --rm -v "$work:/build" "$IMAGE" cp -r /opt/lib /build/lib

run() { docker run --rm -v "$work:/build" "$IMAGE" "$@"; }
run osrm-extract -p /build/akis-car.lua /build/akis.osm.pbf
run osrm-partition /build/akis.osrm
run osrm-customize /build/akis.osrm

osmium tags-filter "$work/akis.osm.pbf" w/highway=motorway -o "$work/motorways.osm.pbf"
osmium export "$work/motorways.osm.pbf" --geometry-types=linestring -f geojsonseq -o "$work/motorways.geojsonseq"

rm -f "$out"/akis.osrm* "$out/motorways.geojsonseq" "$out/motorways.mjs"
mv "$work"/akis.osrm* "$work/motorways.geojsonseq" "$out/"
cp "$here/motorways.mjs" "$out/"
du -sh "$out"
