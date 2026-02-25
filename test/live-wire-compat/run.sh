#!/usr/bin/env bash
# Live wire compatibility test: Go nodes ↔ TS node in same cluster.
#
# Usage: ./test/live-wire-compat/run.sh
#
# Starts a 3-node cluster (2 Go + 1 TS), runs cross-implementation
# tests, then tears everything down.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

GO1="http://localhost:18091"
GO2="http://localhost:18092"
TS1="http://localhost:18093"

PASS=0
FAIL=0
TESTS=()

# ── Helpers ──────────────────────────────────────────────────────────

red()   { printf '\033[31m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
bold()  { printf '\033[1m%s\033[0m' "$*"; }

pass() {
  PASS=$((PASS + 1))
  echo "  $(green '✓') $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  $(red '✗') $1"
  if [ -n "${2:-}" ]; then
    echo "    $(red "  → $2")"
  fi
}

assert_status() {
  local desc="$1" expected="$2" actual="$3"
  shift 3
  local detail="${*:-}"
  if [ "$actual" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc" "expected HTTP $expected, got $actual${detail:+ ($detail)}"
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc"
  else
    fail "$desc" "expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -qF "$expected"; then
    pass "$desc"
  else
    fail "$desc" "expected output to contain '$expected'"
  fi
}

assert_not_empty() {
  local desc="$1" actual="$2"
  if [ -n "$actual" ]; then
    pass "$desc"
  else
    fail "$desc" "expected non-empty value"
  fi
}

wait_healthy() {
  local name="$1" url="$2" max_wait=60 waited=0
  while true; do
    if curl -sf "$url/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    waited=$((waited + 1))
    if [ "$waited" -ge "$max_wait" ]; then
      echo "$(red "ERROR: $name did not become healthy within ${max_wait}s")"
      return 1
    fi
    sleep 1
  done
}

# ── Lifecycle ────────────────────────────────────────────────────────

cleanup() {
  echo ""
  bold "Tearing down cluster..."
  echo ""
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
}

trap cleanup EXIT

echo ""
bold "═══════════════════════════════════════════════════════════"
bold "  REPRAM Live Wire Compatibility Test"
bold "  2 Go nodes + 1 TS node, shared cluster secret"
bold "═══════════════════════════════════════════════════════════"
echo ""

# ── Build & Start ────────────────────────────────────────────────────

bold "Building and starting cluster..."
echo ""
docker compose -f "$COMPOSE_FILE" up --build -d 2>&1 | tail -5
echo ""

bold "Waiting for nodes to become healthy..."
wait_healthy "go-node1" "$GO1"
echo "  go-node1: healthy"
wait_healthy "go-node2" "$GO2"
echo "  go-node2: healthy"
wait_healthy "ts-node1" "$TS1"
echo "  ts-node1: healthy"
echo ""

# Give gossip a moment to propagate topology
sleep 3

# ═══════════════════════════════════════════════════════════════════════
# TEST SUITE
# ═══════════════════════════════════════════════════════════════════════

# ── 1. Health checks ─────────────────────────────────────────────────

bold "1. Health checks"

status=$(curl -s -o /dev/null -w '%{http_code}' "$GO1/v1/health")
assert_status "go-node1 /v1/health" "200" "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' "$GO2/v1/health")
assert_status "go-node2 /v1/health" "200" "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' "$TS1/v1/health")
assert_status "ts-node1 /v1/health" "200" "$status"

# Verify TS node identifies correctly
ts_health=$(curl -sf "$TS1/v1/health")
ts_node_id=$(echo "$ts_health" | python3 -c "import sys,json; print(json.load(sys.stdin)['node_id'])" 2>/dev/null || echo "")
assert_eq "ts-node1 reports correct node_id" "ts-node1" "$ts_node_id"
echo ""

# ── 2. Topology — cross-impl peer discovery ──────────────────────────

bold "2. Topology — cross-implementation peer discovery"

go1_topo=$(curl -sf "$GO1/v1/topology")
go2_topo=$(curl -sf "$GO2/v1/topology")
ts1_topo=$(curl -sf "$TS1/v1/topology")

# go-node1 should see ts-node1 as a peer
assert_contains "go-node1 topology includes ts-node1" "ts-node1" "$go1_topo"

# go-node2 should see ts-node1 as a peer
assert_contains "go-node2 topology includes ts-node1" "ts-node1" "$go2_topo"

# ts-node1 should see both Go nodes
assert_contains "ts-node1 topology includes go-node1" "go-node1" "$ts1_topo"
assert_contains "ts-node1 topology includes go-node2" "go-node2" "$ts1_topo"
echo ""

# ── 3. Store on Go, retrieve from Go (baseline) ─────────────────────

bold "3. Go → Go replication (baseline)"

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-TTL: 300" \
  -d "go-baseline-payload" "$GO1/v1/data/go-baseline-key")
assert_status "PUT to go-node1" "201" "$status"

# Wait for gossip replication
sleep 2

body=$(curl -sf "$GO2/v1/data/go-baseline-key" 2>/dev/null || echo "")
assert_eq "GET from go-node2 returns replicated data" "go-baseline-payload" "$body"
echo ""

# ── 4. Store on Go, retrieve from TS (Go → TS replication) ──────────

bold "4. Go → TS replication"

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-TTL: 300" \
  -d "cross-impl-go-to-ts" "$GO1/v1/data/go-to-ts-key")
assert_status "PUT to go-node1" "201" "$status"

sleep 2

body=$(curl -sf "$TS1/v1/data/go-to-ts-key" 2>/dev/null || echo "")
assert_eq "GET from ts-node1 returns Go-written data" "cross-impl-go-to-ts" "$body"

# Verify TS returns proper metadata headers
remaining_ttl=$(curl -sI "$TS1/v1/data/go-to-ts-key" 2>/dev/null | grep -i "x-remaining-ttl" | tr -d '\r' | awk '{print $2}')
assert_not_empty "ts-node1 returns X-Remaining-TTL header" "$remaining_ttl"

original_ttl=$(curl -sI "$TS1/v1/data/go-to-ts-key" 2>/dev/null | grep -i "x-original-ttl" | tr -d '\r' | awk '{print $2}')
assert_eq "ts-node1 returns correct X-Original-TTL" "300" "$original_ttl"
echo ""

# ── 5. Store on TS, retrieve from Go (TS → Go replication) ──────────

bold "5. TS → Go replication"

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-TTL: 300" \
  -d "cross-impl-ts-to-go" "$TS1/v1/data/ts-to-go-key")
assert_status "PUT to ts-node1" "201" "$status"

sleep 2

body=$(curl -sf "$GO1/v1/data/ts-to-go-key" 2>/dev/null || echo "")
assert_eq "GET from go-node1 returns TS-written data" "cross-impl-ts-to-go" "$body"

body2=$(curl -sf "$GO2/v1/data/ts-to-go-key" 2>/dev/null || echo "")
assert_eq "GET from go-node2 returns TS-written data" "cross-impl-ts-to-go" "$body2"
echo ""

# ── 6. Key listing across implementations ───────────────────────────

bold "6. Key listing consistency"

# Store a prefixed set of keys across all nodes
curl -sf -X PUT -H "X-TTL: 300" -d "a" "$GO1/v1/data/compat:go1" >/dev/null
curl -sf -X PUT -H "X-TTL: 300" -d "b" "$GO2/v1/data/compat:go2" >/dev/null
curl -sf -X PUT -H "X-TTL: 300" -d "c" "$TS1/v1/data/compat:ts1" >/dev/null

sleep 2

# Each node should see all 3 compat: keys
go1_keys=$(curl -sf "$GO1/v1/keys?prefix=compat:")
go2_keys=$(curl -sf "$GO2/v1/keys?prefix=compat:")
ts1_keys=$(curl -sf "$TS1/v1/keys?prefix=compat:")

assert_contains "go-node1 lists compat:ts1" "compat:ts1" "$go1_keys"
assert_contains "go-node2 lists compat:ts1" "compat:ts1" "$go2_keys"
assert_contains "ts-node1 lists compat:go1" "compat:go1" "$ts1_keys"
assert_contains "ts-node1 lists compat:go2" "compat:go2" "$ts1_keys"
assert_contains "ts-node1 lists compat:ts1" "compat:ts1" "$ts1_keys"
echo ""

# ── 7. HEAD request compatibility ────────────────────────────────────

bold "7. HEAD request across implementations"

# HEAD on Go-stored key via TS
head_status=$(curl -s -o /dev/null -w '%{http_code}' -I "$TS1/v1/data/go-to-ts-key")
assert_status "HEAD via ts-node1 for Go-stored key" "200" "$head_status"

# HEAD on TS-stored key via Go
head_status=$(curl -s -o /dev/null -w '%{http_code}' -I "$GO1/v1/data/ts-to-go-key")
assert_status "HEAD via go-node1 for TS-stored key" "200" "$head_status"

# HEAD 404 consistency
head_status=$(curl -s -o /dev/null -w '%{http_code}' -I "$TS1/v1/data/nonexistent-xyz")
assert_status "HEAD 404 from ts-node1" "404" "$head_status"
echo ""

# ── 8. Binary data round-trip ────────────────────────────────────────

bold "8. Binary data round-trip"

# Store binary data (null bytes, high bytes) from Go, retrieve from TS
printf '\x00\x01\x02\xff\xfe\xfd' > /tmp/repram-binary-test
status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-TTL: 300" \
  --data-binary @/tmp/repram-binary-test "$GO1/v1/data/binary-test-key")
assert_status "PUT binary data to go-node1" "201" "$status"

sleep 2

curl -sf -o /tmp/repram-binary-retrieved "$TS1/v1/data/binary-test-key" 2>/dev/null || true
if cmp -s /tmp/repram-binary-test /tmp/repram-binary-retrieved; then
  pass "Binary data round-trip Go → TS preserves bytes"
else
  fail "Binary data round-trip Go → TS" "bytes differ"
fi

rm -f /tmp/repram-binary-test /tmp/repram-binary-retrieved
echo ""

# ── 9. Overwrite semantics ──────────────────────────────────────────

bold "9. Overwrite semantics across implementations"

# Write key on Go, overwrite on TS, read from Go
curl -sf -X PUT -H "X-TTL: 300" -d "version-1" "$GO1/v1/data/overwrite-key" >/dev/null
sleep 1
curl -sf -X PUT -H "X-TTL: 300" -d "version-2" "$TS1/v1/data/overwrite-key" >/dev/null
sleep 2

body=$(curl -sf "$GO1/v1/data/overwrite-key" 2>/dev/null || echo "")
assert_eq "Go reads TS overwrite" "version-2" "$body"

body=$(curl -sf "$GO2/v1/data/overwrite-key" 2>/dev/null || echo "")
assert_eq "Go node2 reads TS overwrite" "version-2" "$body"
echo ""

# ── 10. Status endpoint compatibility ────────────────────────────────

bold "10. Status endpoint"

ts_status=$(curl -sf "$TS1/v1/status")
assert_contains "ts-node1 /v1/status includes node_id" "ts-node1" "$ts_status"
assert_contains "ts-node1 /v1/status includes uptime" "uptime" "$ts_status"
assert_contains "ts-node1 /v1/status includes memory" "rss" "$ts_status"
echo ""

# ═══════════════════════════════════════════════════════════════════════
# RESULTS
# ═══════════════════════════════════════════════════════════════════════

echo ""
TOTAL=$((PASS + FAIL))
bold "═══════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  bold "  $(green "ALL $TOTAL TESTS PASSED")"
else
  bold "  $(green "$PASS passed"), $(red "$FAIL failed") out of $TOTAL"
fi
bold "═══════════════════════════════════════════════════════════"
echo ""

# Exit with failure if any tests failed
[ "$FAIL" -eq 0 ]
