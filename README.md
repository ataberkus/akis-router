# akis-router

Builds the OpenStreetMap router data (OSRM v6, car profile, all of Türkiye) for Akış on a GitHub runner and hands it to
Akış's server, whose install script serves it. Public so the build runs on GitHub's free standard runners; it holds no
secrets (the server key is a repository secret). Map data © OpenStreetMap contributors, ODbL 1.0, via Geofabrik.
