# akis-router

Builds the OpenStreetMap router data (OSRM v6, car profile, all of Türkiye) for Akış on a GitHub runner and hands it to
Akış's server, whose install script serves it. Also hands over the motorway points, speed limits and speed cameras
(osmium exports only; the server accepts nothing but data files); `closed-ways.txt` lists OSM ways the router must
never use (known closures). These files are copies: their source is `backend/host/osrm` in
Akış's private repository. Public so the build runs on GitHub's free standard runners; it holds no
secrets (the server key is a repository secret). Map data © OpenStreetMap contributors, ODbL 1.0, via Geofabrik.
