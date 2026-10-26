#!/usr/bin/env bash
#
# Runs once when the dev container (or a GitHub Codespace) is created.
#
# `npm ci` installs the lockfile exactly, so a contributor's first test run is
# the same one CI runs. The Stellar CLI is the contract-side tool the docs and
# the contract repository use; it is fetched from its latest GitHub release
# instead of built from source, which would add several minutes to container
# creation. Nothing here needs a secret.
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) target="x86_64-unknown-linux-gnu" ;;
  aarch64 | arm64) target="aarch64-unknown-linux-gnu" ;;
  *)
    echo "stellar-cli: no prebuilt binary for '$arch'" >&2
    exit 1
    ;;
esac

# The release asset carries the version in its name, so the metadata is read
# rather than guessing a URL. Node is already in the image and has fetch.
url="$(node --input-type=module - "$target" <<'EOF'
const target = process.argv[2];
const response = await fetch(
  "https://api.github.com/repos/stellar/stellar-cli/releases/latest",
  { headers: { "user-agent": "payflow-devcontainer" } },
);
if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
const release = await response.json();
const asset = release.assets.find((candidate) =>
  candidate.name.endsWith(`-${target}.tar.gz`),
);
if (!asset) throw new Error(`no stellar-cli asset for ${target}`);
process.stdout.write(asset.browser_download_url);
EOF
)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" | tar -xz -C "$tmp"
sudo install -m 0755 "$tmp/stellar" /usr/local/bin/stellar
stellar --version
