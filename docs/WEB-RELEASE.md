# Forge Web Server release

The main branch distributes Forge as a local web server. It runs on the
user's own computer and opens the workbench in their browser. It is not a
hosted service.

## Install and run

Requires Node.js 22.19 or newer. Download forge-web-<version>.tar.gz from
the GitHub Release, then:

~~~bash
tar -xzf forge-web-<version>.tar.gz
cd forge-web-<version>
npm ci --omit=dev
npm start
~~~

Forge opens http://127.0.0.1:5300 in the default browser. The terminal
prints the exact URL if the browser does not open automatically. Use
npm start -- --no-open to leave browser selection to the user, or
npm start -- --port 0 to choose an available local port.

In the workbench, add a project by entering its absolute path on the same
computer that runs the server. Model subscriptions are configured in Settings.
Session data lives under ~/.forge by default.

Keep the terminal running while using Forge. Ctrl+C stops the server. Existing
session history is retained and an interrupted session can be resumed.

The server accepts connections only on 127.0.0.1; it does not expose the
engineering tools to the local network or the internet. Do not put it behind
a public reverse proxy. Remote access needs its own authentication and trust
design.

## Build and verify from source

~~~bash
bash scripts/release-check.sh
bash scripts/build-web-release.sh
node scripts/smoke-web-release.mjs
~~~

The smoke extracts the archive into a fresh directory, installs only
production dependencies, starts the packaged server with a fresh data
directory and checks the page, JavaScript asset and authenticated API.

## Maintainer release checklist

Release from `main` only after choosing a version and reviewing the complete
diff. Update the package version and lockfile together. Run the release gate;
its smoke rebuilds and clean-installs an archive from the current tree. Build
the final archive from that unchanged tree, inspect its contents (including
`INSTALL.md`, built `desktop/dist` assets, Forge source and tracked Pi package
`dist` files), and compute its checksum. Only then tag the commit and attach
that archive and checksum to a GitHub Release. A successful source checkout or
dev preview is not release evidence. Releasing `main` does not update or tag
`master`.
