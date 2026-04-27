#!/usr/bin/env bash
# Build the two burn-in node images with a baked-in test omega pubkey.
#
# Usage: build-images.sh [<pubkey-file>]
#   pubkey-file: defaults to ~/.repram-burnin/omega.pub
#                (produced by setup-keypair.sh)
#
# Output: docker images repram-burnin/go-node:latest and
#         repram-burnin/ts-node:latest, ready to run on any Docker host.
#
# Distribute via:
#   docker save repram-burnin/go-node:latest | gzip > go-node.tar.gz
#   scp go-node.tar.gz <host>:
#   ssh <host> 'gunzip -c go-node.tar.gz | docker load'
# or push to a private/local registry. Do NOT push to a public registry —
# the corresponding private key would let anyone impersonate roots.

set -euo pipefail

repo_root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
pubkey_file="${1:-$HOME/.repram-burnin/omega.pub}"

if [[ ! -f "$pubkey_file" ]]; then
    echo "pubkey file not found: $pubkey_file" >&2
    echo "run setup-keypair.sh first, or pass the path as arg 1" >&2
    exit 1
fi

pubkey=$(tr -d '[:space:]' < "$pubkey_file")
if [[ -z "$pubkey" ]]; then
    echo "pubkey file is empty: $pubkey_file" >&2
    exit 1
fi

echo "Building with pubkey: $pubkey"
echo

echo "==> repram-burnin/go-node:latest"
docker build \
    --build-arg "TEST_OMEGA_PUBKEY=$pubkey" \
    -f "$repo_root/test/burnin/Dockerfile.go-node" \
    -t repram-burnin/go-node:latest \
    "$repo_root"

echo
echo "==> repram-burnin/ts-node:latest"
docker build \
    --build-arg "TEST_OMEGA_PUBKEY=$pubkey" \
    -f "$repo_root/test/burnin/Dockerfile.ts-node" \
    -t repram-burnin/ts-node:latest \
    "$repo_root/repram-mcp"

echo
echo "Done. To verify the bake:"
echo "  docker run --rm --entrypoint sh repram-burnin/go-node:latest -c 'strings repram | grep -c $pubkey'"
echo "  (should print 1 — the constant is embedded in the binary)"
