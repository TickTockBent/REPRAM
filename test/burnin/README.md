# REPRAM 2.1 — Burn-in Test Harness

Operator runbook for the 48-hour baseline test described in
`docs/internal/REPRAM-2.1-Minimal-BurnIn.md`.

## What's here

| File | Purpose |
| --- | --- |
| `setup-keypair.sh` | Generate a single-use omega keypair. |
| `Dockerfile.go-node` | Burn-in image for the Go node, with baked test pubkey. |
| `Dockerfile.ts-node` | Burn-in image for the TS node, with baked test pubkey. |
| `build-images.sh` | Build both images from a pubkey file. |
| `sign-loop.sh` | Re-sign + republish the omega TXT record every 25 min. |
| `workload.js` | k6 workload generator (50 ops/sec, 48h). |
| `prometheus-scrape.yml` | Drop-in scrape job for the existing Prometheus stack. |
| `grafana-dashboard.json` | 6-panel dashboard, importable to Grafana. |

## One-time setup (observer host)

```bash
# 1. Generate the test keypair (~/.repram-burnin/omega.{priv,pub})
./test/burnin/setup-keypair.sh

# 2. Build both burn-in images
./test/burnin/build-images.sh

# 3. Tag and push to Docker Hub so the Windows hosts can pull directly.
#    (Tags use :experimental — never push to :latest, which represents the
#    production omega pubkey, not the burn-in test key.)
docker tag repram-burnin/go-node:latest ticktockbent/repram-node:experimental
docker tag repram-burnin/ts-node:latest ticktockbent/repram-node:experimental-ts
docker push ticktockbent/repram-node:experimental
docker push ticktockbent/repram-node:experimental-ts
# (Both go in the same `repram-node` repo — the -ts suffix marks the
#  TypeScript impl. The Go image is the unsuffixed :experimental tag.)
```

The private key in `~/.repram-burnin/omega.priv` stays on the observer
forever — never copy it to a node. Delete both the privkey and pubkey at
teardown. The `:experimental` tags on Docker Hub also have the test pubkey
baked in; delete those tags at teardown too.

## Per-host runbook

Cluster topology:

- **node-a** (root, Go) — `10.0.20.72` (this Linux machine, also runs the observer stack)
- **node-b** (Go, Windows) — `10.0.10.81`
- **node-c** (TS, Windows) — `10.0.10.104`

Each node advertises itself as `<lan-ip>:9090` so those exact addresses must
appear in the signed list (`NODES` in `sign-loop.sh`).

### node-a (root, Go, also the observer)

```bash
docker run -d --name repram-node-a \
  -p 8080:8080 -p 9090:9090 \
  -v /var/lib/repram/cache:/data/cache \
  -e REPRAM_NETWORK=public \
  -e REPRAM_ENCLAVE=default \
  -e REPRAM_LOG_LEVEL=info \
  -e REPRAM_NODE_ID=node-a \
  -e REPRAM_ADDRESS=10.0.20.72 \
  -e REPRAM_GOSSIP_PORT=9090 \
  -e REPRAM_HTTP_PORT=8080 \
  --dns 127.0.0.1 \
  ticktockbent/repram-node:experimental
```

`--dns 127.0.0.1` (or the observer's LAN address) routes DNS through
dnsmasq so it sees the test omega TXT records. Adjust per host.

### node-b (Go, Windows)

Same as node-a, with `node-b`, `10.0.10.81`, and a Windows-friendly
bind mount:

```powershell
docker run -d --name repram-node-b `
  -p 8080:8080 -p 9090:9090 `
  -v C:\repram-cache:/data/cache `
  -e REPRAM_NETWORK=public `
  -e REPRAM_ENCLAVE=default `
  -e REPRAM_LOG_LEVEL=info `
  -e REPRAM_NODE_ID=node-b `
  -e REPRAM_ADDRESS=10.0.10.81 `
  -e REPRAM_GOSSIP_PORT=9090 `
  -e REPRAM_HTTP_PORT=8080 `
  --dns 10.0.20.72 `
  ticktockbent/repram-node:experimental
```

### node-c (TS, Windows)

```powershell
docker run -d --name repram-node-c `
  -p 8080:8080 -p 9090:9090 `
  -v C:\repram-cache:/data/cache `
  -e REPRAM_NETWORK=public `
  -e REPRAM_ENCLAVE=default `
  -e REPRAM_LOG_LEVEL=info `
  -e REPRAM_NODE_ID=node-c `
  -e REPRAM_ADDRESS=10.0.10.104 `
  -e REPRAM_GOSSIP_PORT=9090 `
  -e REPRAM_HTTP_PORT=8080 `
  --dns 10.0.20.72 `
  ticktockbent/repram-node:experimental-ts
```

The TS image already has `REPRAM_MODE=standalone` baked in.

## Observer processes

Run all three in separate tmux/screen panes so you can read each one's
output. The processes are independent — restarting any one doesn't affect
the others.

```bash
# 1. dnsmasq — install per distro, then point /etc/dnsmasq.conf at the
#    burn-in hosts file:
#      conf-file=/etc/dnsmasq.d/repram-burnin.conf
#    Restart: sudo systemctl restart dnsmasq
#    Verify: dig _bootstrap.repram.io @127.0.0.1

# 2. sign-loop: re-signs every 25 min
PRIVATE_KEY=~/.repram-burnin/omega.priv \
NODES=10.0.20.72:9090,10.0.10.81:9090,10.0.10.104:9090 \
DNSMASQ_HOSTS_FILE=/etc/dnsmasq.d/repram-burnin.conf \
./test/burnin/sign-loop.sh

# 3. workload generator
k6 run \
  -e REPRAM_NODES=http://10.0.20.72:8080,http://10.0.10.81:8080,http://10.0.10.104:8080 \
  -e BURNIN_DURATION=48h \
  test/burnin/workload.js
```

The bootstrap-gate (`/v1/bootstrap` returning 403 for non-listed nodes)
isn't probed in this baseline run — every node in the burn-in is in the
signed list and therefore a root, so there's no negative case to assert.
The gate is exercised properly in the perturbation test (separate run)
by adding a fourth, unlisted node.

## Monitoring setup (observer)

```bash
# 1. Append the scrape jobs to your existing prometheus.yml
cat test/burnin/prometheus-scrape.yml  # review first
# (manually merge the scrape_configs into your prometheus.yml)
sudo systemctl reload prometheus

# 2. (Optional) Enable Prometheus remote-write so k6 can push workload metrics.
#    Add to prometheus startup args: --web.enable-remote-write-receiver
#    Then run k6 with:
#      K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
#      k6 run --out experimental-prometheus-rw test/burnin/workload.js

# 3. Import the Grafana dashboard
#    In Grafana UI: Dashboards > Import > paste test/burnin/grafana-dashboard.json
#    Select your existing Prometheus datasource when prompted.
```

### Metrics coverage

All six dashboard panels have full data on both Go and TS nodes:

| Metric | Source |
| --- | --- |
| `go_memstats_heap_inuse_bytes` (Go) / `process_resident_memory_bytes` (TS) | `/v1/metrics` |
| `go_goroutines` (Go) / `nodejs_eventloop_lag_seconds` (TS) | `/v1/metrics` |
| `repram_peers_active`, `repram_peer_evictions_total` | `/v1/metrics` (both impls) |
| `repram_omega_last_refresh_unix_seconds` | `/v1/metrics` (both impls), updated on each successful refresh |
| k6 metrics | k6 → Prometheus remote-write |

## Pre-flight checks

Before kicking off the 48h run:

1. **dnsmasq reachable from each node:** `dig TXT _bootstrap.repram.io @<observer-ip>` returns the omega target; following with `dig TXT _omega.repram.io @<observer-ip>` returns the signed list.
2. **All three nodes recognize themselves:** check the startup log for `Initial root status: bootstrap root` on node-a and `Initial root status: not a root` on node-b/c.
3. **Cluster is connected:** `curl http://10.0.20.72:8080/v1/topology` shows all three nodes.
4. **All three nodes self-recognize as roots:** `Initial root status: bootstrap root` in each startup log (every address in the signed list is a root).
5. **Cache files exist after the first refresh:** `ls /data/cache/root-list.json` (in container) or the bind-mount equivalent.
6. **Workload generator can write:** `curl -X PUT http://10.0.20.72:8080/v1/data/test -d hi -H "X-TTL: 300"` returns 200.

If any of these fail, stop and fix before starting the 48h timer.

## Teardown

```bash
# 1. Capture artifacts (per the burn-in spec)
mkdir -p burn-in-$(date +%Y-%m-%d)
cd burn-in-$(date +%Y-%m-%d)
for node in node-a node-b node-c; do
    curl -s http://${node}-ip:8080/debug/pprof/heap > heap-${node}.pprof
    curl -s http://${node}-ip:8080/debug/pprof/goroutine > goroutine-${node}.pprof
    curl -s http://${node}-ip:8080/v1/status > status-${node}.json
    curl -s http://${node}-ip:8080/v1/topology > topology-${node}.json
done
# Copy logs, dnsmasq logs, prometheus snapshot, cache files (root-list.json)

# 2. Stop everything
docker stop repram-node-a repram-node-b repram-node-c
# Stop k6, probe.sh, sign-loop.sh, dnsmasq

# 3. Delete the test keypair
shred -u ~/.repram-burnin/omega.priv
rm ~/.repram-burnin/omega.pub

# 4. Remove burn-in images locally and from Docker Hub (the test pubkey is
#    baked in; leaving them around invites someone to spin up a stale test
#    cluster that talks to nothing).
docker rmi repram-burnin/go-node:latest repram-burnin/ts-node:latest \
           ticktockbent/repram-node:experimental \
           ticktockbent/repram-node:experimental-ts
# Then on hub.docker.com: delete both experimental tags from
# ticktockbent/repram-node.
```
