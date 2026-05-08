# REPRAM 2.1 Burn-in — Command Runbook

Copy-paste-ready blocks, one section per preflight task. Sections are added as
we progress — only completed/in-flight tasks have content.

---

## Task 22 — dnsmasq setup (observer, 10.0.20.72)

Installs dnsmasq listening only on the LAN IP (leaves systemd-resolved alone
on loopback), creates the drop-in dir for sign-loop.sh, writes a systemd unit
(the package didn't ship one), opens UFW from the burn-in subnet.

```bash
sudo install -d -m 755 /etc/dnsmasq.d

sudo tee /etc/dnsmasq.conf >/dev/null <<'EOF'
# REPRAM 2.1 burn-in — observer-side DNS for the test cluster.
# Bind only to the LAN address so systemd-resolved keeps owning loopback.
listen-address=10.0.20.72
bind-interfaces

# Drop-ins (sign-loop.sh writes the burn-in TXT records here).
conf-dir=/etc/dnsmasq.d/,*.conf

# Forward unknown queries upstream so burn-in nodes still reach Docker Hub etc.
server=1.1.1.1
server=8.8.8.8
no-hosts
no-resolv

# Useful during preflight; remove or comment out for the long run if noisy.
log-queries
log-facility=/var/log/dnsmasq.log
EOF

# Empty drop-in so dnsmasq starts cleanly before sign-loop.sh runs.
sudo touch /etc/dnsmasq.d/repram-burnin.conf

sudo tee /etc/systemd/system/dnsmasq.service >/dev/null <<'EOF'
[Unit]
Description=dnsmasq (REPRAM burn-in)
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=/usr/sbin/dnsmasq --test
ExecStart=/usr/sbin/dnsmasq -k
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo dnsmasq --test
sudo systemctl daemon-reload
sudo systemctl enable --now dnsmasq
sudo systemctl status --no-pager dnsmasq | head -15
```

UFW rules (only if UFW is enabled):

```bash
sudo ufw allow from 10.0.10.0/24 to any port 53 proto udp
sudo ufw allow from 10.0.10.0/24 to any port 53 proto tcp
sudo ufw status | grep " 53"
```

Local verification:

```bash
dig +short TXT github.com @10.0.20.72
```

Should return one or more TXT strings (proves upstream forwarding works).

---

## Task 23 — DNS reachability from the Windows hosts

Run on each Windows host (PowerShell or Command Prompt). The first query
proves the host can talk to the observer's dnsmasq at all; the second two
will return nothing useful until sign-loop has run, but should NOT time out
or report SERVFAIL — they should report NXDOMAIN.

### 10.0.10.81 (node-b)

```powershell
nslookup -type=TXT github.com 10.0.20.72
nslookup -type=TXT _bootstrap.repram.io 10.0.20.72
nslookup -type=TXT _omega.repram.io 10.0.20.72
```

### 10.0.10.104 (node-c)

```powershell
nslookup -type=TXT github.com 10.0.20.72
nslookup -type=TXT _bootstrap.repram.io 10.0.20.72
nslookup -type=TXT _omega.repram.io 10.0.20.72
```

Expected:

- `github.com` returns the same long list of TXT verification records you
  saw on the observer.
- `_bootstrap.repram.io` and `_omega.repram.io` return
  `*** Non-existent domain` (or `NXDOMAIN`) — the records aren't there yet.
  This is correct: NXDOMAIN proves the query reached dnsmasq and got an
  authoritative answer that there's no such record. Sign-loop will populate
  them in task 24.

If a query times out instead, port 53 isn't reachable from that host —
re-check the UFW rules and Windows Defender Firewall on the host.

---

## Task 24 — First signed list, manually published

Skip `sign-loop.sh` for this preflight step — just sign once, install into
dnsmasq, and verify resolvers see the records. We'll start the actual loop
in task 32.

Run on the observer:

```bash
cd /home/ticktockbent/projects/infrastructure/repram

# Sign a signed list (30-minute validity, all three burn-in nodes).
./bin/repram-omega sign \
    --key ~/.repram-burnin/omega.priv \
    --expires-in 30m \
    --nodes 10.0.20.72:9090,10.0.10.81:9090,10.0.10.104:9090 \
    > /tmp/repram-burnin-signed.txt

cat /tmp/repram-burnin-signed.txt
```

You should see a single line like
`v=omega-v1;exp=...;nodes=...;sig=...` (no whitespace).

Install it into dnsmasq:

```bash
sudo tee /etc/dnsmasq.d/repram-burnin.conf >/dev/null <<EOF
# Manually generated for task-24 verification.
txt-record=_bootstrap.repram.io,"omega=_omega.repram.io"
txt-record=_omega.repram.io,"$(cat /tmp/repram-burnin-signed.txt)"
EOF

# Full restart, NOT reload — dnsmasq's SIGHUP doesn't re-read txt-record
# entries, only /etc/hosts and lease files. A reload looks successful but
# silently drops the new records.
sudo systemctl restart dnsmasq
sudo systemctl status --no-pager dnsmasq | head -5
```

Verify locally:

```bash
dig TXT _bootstrap.repram.io @10.0.20.72 +noall +answer
dig TXT _omega.repram.io     @10.0.20.72 +noall +answer
```

Then on each Windows host (10.0.10.81 and 10.0.10.104):

```powershell
nslookup -type=TXT _bootstrap.repram.io 10.0.20.72
nslookup -type=TXT _omega.repram.io 10.0.20.72
```

Expected:

- `_bootstrap.repram.io` → one TXT string `omega=_omega.repram.io`
- `_omega.repram.io` → the long signed-list string. `dig` may show it as
  several quoted character-strings concatenated with spaces — that's the
  DNS wire format chunking, our resolvers stitch them back together.

Paste the `dig` output back here and I'll confirm the format is what the
REPRAM resolver expects.

---

## Task 25 — Start node-a (root, on observer)

### Port assignments (avoid conflicts on observer)

All three burn-in nodes use **port 18080 for both HTTP and gossip-port
self-recognition** (`gossip_port == http_port`). This is a workaround for
a defect in REPRAM 2.1: the bootstrap caller in
`internal/gossip/bootstrap.go:74` treats the seed-list address as
`host:http_port`, but the signed list contains `host:gossip_port`. The
two have to be the same number for omega bootstrap to work end-to-end.
Existing integration tests use `REPRAM_PEERS` and never hit this path —
the burn-in is the first thing to actually exercise the signed-list
bootstrap flow on a multi-node cluster.

The signed list has already been re-issued with `*:18080`:

```
v=omega-v1;exp=…;nodes=10.0.10.104:18080,10.0.10.81:18080,10.0.20.72:18080;sig=…
```

### Pre-create the cache bind-mount with the right ownership

The container runs as UID 1000 (`repram`). Match that on the host so the
container can write to the mounted cache directory.

```bash
sudo install -d -o 1000 -g 1000 -m 0755 /var/lib/repram/cache
ls -ld /var/lib/repram/cache
```

### Start node-a

`--dns 10.0.20.72` is critical: from inside a container `127.0.0.1` is the
container's own loopback, not the host's. The container reaches the
observer's dnsmasq via the host's LAN IP.

```bash
docker run -d --name repram-node-a \
  -p 18080:18080 -p 6060:6060 \
  -v /var/lib/repram/cache:/data/cache \
  -e REPRAM_NETWORK=public \
  -e REPRAM_ENCLAVE=default \
  -e REPRAM_LOG_LEVEL=info \
  -e REPRAM_NODE_ID=node-a \
  -e REPRAM_ADDRESS=10.0.20.72 \
  -e REPRAM_GOSSIP_PORT=18080 \
  -e REPRAM_HTTP_PORT=18080 \
  -e REPRAM_RATE_LIMIT=10000 \
  -e REPRAM_PPROF_ENABLED=true \
  -e REPRAM_PPROF_ADDR=0.0.0.0:6060 \
  --dns 10.0.20.72 \
  ticktockbent/repram-node:experimental
```

### Verify startup

```bash
sleep 3
docker logs repram-node-a 2>&1 | head -30
echo
echo "=== /v1/health ==="
curl -s http://10.0.20.72:18080/v1/health
echo
echo "=== /v1/metrics (omega refresh + peers) ==="
curl -s http://10.0.20.72:18080/v1/metrics | grep -E "^repram_(peers_active|omega_last_refresh)"
echo
echo "=== cache file ==="
sudo ls -la /var/lib/repram/cache/
```

Expected in the logs:

- `Omega bootstrap: verified signed root list (3 nodes, expires …)`
- `Initial root status: bootstrap root (advertised as 10.0.20.72:9090)`
- `REPRAM node online. Peers: 0. Network: public`

`repram_omega_last_refresh_unix_seconds` should now be a non-zero unix
time. `/var/lib/repram/cache/root-list.json` should exist (written by the
verified-list cache code).

If anything fails (omega bootstrap fatal, signature mismatch, etc.) paste
the logs back. The container exits on a fatal — `docker ps -a` will show
status `Exited`.

---

## Task 26 — Start node-b (Windows, Go) and node-c (Windows, TS)

Both Windows hosts use the same port pair as node-a (HTTP 18080, gossip
19090). No pre-create needed for the cache dir on Windows — Docker
Desktop handles the file-sharing layer.

### node-b on 10.0.10.81 (Go)

```powershell
docker stop repram-smoke 2>$null
docker rm repram-smoke 2>$null

if (-Not (Test-Path C:\repram-cache)) { New-Item -ItemType Directory -Path C:\repram-cache | Out-Null }

docker run -d --name repram-node-b `
  -p 18080:18080 -p 6060:6060 `
  -v C:\repram-cache:/data/cache `
  -e REPRAM_NETWORK=public `
  -e REPRAM_ENCLAVE=default `
  -e REPRAM_LOG_LEVEL=info `
  -e REPRAM_NODE_ID=node-b `
  -e REPRAM_ADDRESS=10.0.10.81 `
  -e REPRAM_GOSSIP_PORT=18080 `
  -e REPRAM_HTTP_PORT=18080 `
  -e REPRAM_RATE_LIMIT=10000 `
  -e REPRAM_PPROF_ENABLED=true `
  -e REPRAM_PPROF_ADDR=0.0.0.0:6060 `
  --dns 10.0.20.72 `
  ticktockbent/repram-node:experimental

Start-Sleep -Seconds 25
docker logs repram-node-b
```

### node-c on 10.0.10.104 (TS)

```powershell
docker stop repram-smoke 2>$null
docker rm repram-smoke 2>$null

if (-Not (Test-Path C:\repram-cache)) { New-Item -ItemType Directory -Path C:\repram-cache | Out-Null }

docker run -d --name repram-node-c `
  -p 18080:18080 -p 6060:6060 `
  -v C:\repram-cache:/data/cache `
  -e REPRAM_NETWORK=public `
  -e REPRAM_ENCLAVE=default `
  -e REPRAM_LOG_LEVEL=info `
  -e REPRAM_NODE_ID=node-c `
  -e REPRAM_ADDRESS=10.0.10.104 `
  -e REPRAM_GOSSIP_PORT=18080 `
  -e REPRAM_HTTP_PORT=18080 `
  -e REPRAM_RATE_LIMIT=10000 `
  -e REPRAM_PPROF_ENABLED=true `
  -e REPRAM_PPROF_ADDR=0.0.0.0:6060 `
  --dns 10.0.20.72 `
  ticktockbent/repram-node:experimental-ts --standalone

Start-Sleep -Seconds 25
docker logs repram-node-c
```

Expected log lines on each:

- `Omega bootstrap: verified signed root list (3 nodes, expires …)`
- `Initial root status: bootstrap root (advertised as 10.0.10.{81|104}:19090)`
- Bootstrap successes from the live peers it can reach (node-a always,
  the other Windows node once it's up too)

Once both are running, paste back the bootstrap-related lines from each
log — I'll verify the cluster has converged before we move to task 27.

---

## Task 27 — Verify cluster topology

```bash
echo "=== peers_active per node ==="
for ip in 10.0.20.72 10.0.10.81 10.0.10.104; do
  v=$(curl -s -m 3 http://${ip}:18080/v1/metrics | grep "^repram_peers_active " | awk '{print $2}')
  echo "  ${ip}: ${v}"
done

echo
echo "=== topology per node ==="
for ip in 10.0.20.72 10.0.10.81 10.0.10.104; do
  echo "  --- ${ip} ---"
  curl -s -m 3 http://${ip}:18080/v1/topology | python3 -m json.tool
done
```

Expected: each Go node reports `peers_active=2`. The TS node (node-c)
reports `peers_active=3` because of finding F7 (TS-side gossip stores
self in peer map). All three nodes' `/v1/topology` should list the
other two nodes; node-c will additionally list itself.

If any Go node reports fewer than 2 peers, that node missed its
bootstrap window. Restart it: `docker restart repram-node-{a|b|c}`
and re-verify after ~10 seconds.

---

## Task 29 — Smoke test (curl-based, replication across cluster)

This is a faster sanity check than spinning up k6 for the real run.
PUTs to each node, GETs from every other node, count successes.

```bash
echo "=== smoke: write 5 keys to each node, read back from the others ==="
ok=0
fail=0
for source in 10.0.20.72 10.0.10.81 10.0.10.104; do
  for i in 1 2 3 4 5; do
    key="smoke/${source}/${i}-$(date +%s%N)"
    val="from-${source}-iter-${i}"

    # PUT
    code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X PUT -H "X-TTL: 600" -d "${val}" \
        "http://${source}:18080/v1/data/${key}")
    if [[ "$code" != "201" && "$code" != "200" && "$code" != "202" ]]; then
        echo "  FAIL PUT $key on $source (HTTP $code)"
        fail=$((fail+1))
        continue
    fi

    # GET from every other node
    sleep 0.2  # tiny gap for replication
    for target in 10.0.20.72 10.0.10.81 10.0.10.104; do
        [[ "$target" == "$source" ]] && continue
        body=$(curl -s -m 3 "http://${target}:18080/v1/data/${key}")
        if [[ "$body" == "$val" ]]; then
            ok=$((ok+1))
        else
            echo "  FAIL GET $key on $target (got: '$body')"
            fail=$((fail+1))
        fi
    done
  done
done
echo
echo "=== summary: ${ok} ok, ${fail} fail ==="
```

Expected: 30 ok / 0 fail (5 keys × 3 source nodes × 2 reader nodes).
If any fail, the cluster has an asymmetric edge — fix before proceeding.

NOTE: keys must be slash-free for the cluster to handle them uniformly
(see preflight finding F11). Use dashes for hierarchy.

---

## Task 30 — Wire Prometheus scrape config

The existing stack lives at `~/projects/infrastructure/homelab-monitoring/`
and uses `file_sd_configs` for all targets. Match that pattern:

```bash
# 1. New target file (lists the 3 burnin nodes with cluster=burnin labels)
cat > ~/projects/infrastructure/homelab-monitoring/prometheus/targets/repram-burnin.yml <<'EOF'
- targets:
    - 10.0.20.72:18080
    - 10.0.10.81:18080
  labels:
    cluster: burnin
    impl: go

- targets:
    - 10.0.10.104:18080
  labels:
    cluster: burnin
    impl: ts
EOF

# 2. Add the scrape job to prometheus.yml (insert above blackbox-http).
#    Already done — diff:
#      + - job_name: repram-burnin
#      +   metrics_path: /v1/metrics
#      +   file_sd_configs:
#      +     - files:
#      +         - /etc/prometheus/targets/repram-burnin.yml
#      +       refresh_interval: 1m

# 3. Reload Prometheus (no restart needed — lifecycle endpoint enabled)
curl -s -X POST http://localhost:9090/-/reload -w "HTTP %{http_code}\n"

# 4. Verify all 3 targets UP after one scrape cycle (~30s):
curl -s "http://localhost:9090/api/v1/targets?state=active" \
  | python3 -c "
import json, sys
for t in json.load(sys.stdin)['data']['activeTargets']:
    if 'burnin' in t['labels'].get('cluster',''):
        print(f\"  {t['labels']['instance']} ({t['labels']['impl']})  health={t['health']}\")
"
```

---

## Task 31 — Import Grafana dashboard

Grafana auto-loads from `grafana/dashboards/` every 30s (per the
provisioning config in `grafana/provisioning/dashboards/dashboards.yml`).

```bash
cp /home/ticktockbent/projects/infrastructure/repram/test/burnin/grafana-dashboard.json \
   ~/projects/infrastructure/homelab-monitoring/grafana/dashboards/repram-burnin.json
```

Wait ≤30s and the dashboard appears in the **Homelab** folder under
"REPRAM 2.1 Burn-In". Direct URL: http://localhost:3000/d/repram-burnin-2-1/

**Login:** username `admin`, password from `~/projects/infrastructure/homelab-monitoring/.env` (`GRAFANA_ADMIN_PASSWORD`).
DO NOT make repeated wrong-password attempts — Grafana locks the admin
account for ~5 minutes after a handful of failures. If you trip it,
`docker restart grafana` resets the counter.

---

## Task 32 — Launch the long-runners (start the 72h timer)

### 32a. Passwordless sudo for sign-loop

sign-loop.sh runs every 25 min for 72h. It needs to write to
`/etc/dnsmasq.d/repram-burnin.conf` and restart dnsmasq each cycle —
prompting for sudo every cycle defeats the unattended-loop point.

```bash
sudo tee /etc/sudoers.d/repram-burnin >/dev/null <<'EOF'
ticktockbent ALL=(root) NOPASSWD: /bin/systemctl restart dnsmasq, /usr/bin/tee /etc/dnsmasq.d/repram-burnin.conf*
EOF
sudo chmod 0440 /etc/sudoers.d/repram-burnin
sudo visudo -c   # syntax check; should print "/etc/sudoers.d/repram-burnin: parsed OK"

# Sanity test: should succeed without a prompt
sudo -n systemctl restart dnsmasq
echo "exit=$?"
```

### 32b. k6 — pick one install path

`apt install k6` doesn't work on Ubuntu's stock repos. Three options:

**Option A — Docker (recommended; consistent with everything else):**

```bash
# Smoke test it first (10s, 5 ops/sec) before committing to 72h
docker run --rm -i --network host \
  -v /home/ticktockbent/projects/infrastructure/repram/test/burnin:/work \
  -e REPRAM_NODES=http://10.0.20.72:18080,http://10.0.10.81:18080,http://10.0.10.104:18080 \
  -e BURNIN_DURATION=10s \
  grafana/k6 run /work/workload.js
```

**Option B — Grafana's apt repo:**

```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Option C — snap:** `sudo snap install k6` — works, but pulls in
snapd machinery if not already present.

### 32c. Smoke the workload generator (always do this first)

```bash
# 10 second sanity run before committing 48 hours
docker run --rm -i --network host \
  -v /home/ticktockbent/projects/infrastructure/repram/test/burnin:/work \
  -e REPRAM_NODES=http://10.0.20.72:18080,http://10.0.10.81:18080,http://10.0.10.104:18080 \
  -e BURNIN_DURATION=10s \
  grafana/k6 run /work/workload.js
```

Look at the summary at the end:
- `http_req_failed` rate near zero
- `checks` near 100%
- No `setup() ran error` or fetch failures
- ~500 requests in 10s × 50 RPS

If anything's red, fix before launching the 72h.

### 32d. Long-running tmux session (launch the 72h timer)

Three panes — each independent.

```bash
# Pane 1: sign-loop (sign every 25min, restart dnsmasq)
PRIVATE_KEY=$HOME/.repram-burnin/omega.priv \
NODES=10.0.20.72:18080,10.0.10.81:18080,10.0.10.104:18080 \
DNSMASQ_HOSTS_FILE=/etc/dnsmasq.d/repram-burnin.conf \
/home/ticktockbent/projects/infrastructure/repram/test/burnin/sign-loop.sh \
  | tee -a $HOME/.repram-burnin/sign-loop.log

# Pane 2: k6 — full 48h with Prometheus remote-write enabled
docker run --rm -i --network host \
  -v /home/ticktockbent/projects/infrastructure/repram/test/burnin:/work \
  -e REPRAM_NODES=http://10.0.20.72:18080,http://10.0.10.81:18080,http://10.0.10.104:18080 \
  -e BURNIN_DURATION=72h \
  -e K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  grafana/k6 run --out experimental-prometheus-rw /work/workload.js \
  | tee -a $HOME/.repram-burnin/k6.log

# Pane 3: dashboard watcher — keep eyes on it during initial 30 min
echo "Open: http://localhost:3000/d/repram-burnin-2-1/"
echo "Start time:  $(date -Is)"
echo "Expected end: $(date -Is -d '+72 hours')"
```

For Prometheus remote-write to accept k6's pushes, Prometheus needs
`--web.enable-remote-write-receiver`. Add it to
`~/projects/infrastructure/homelab-monitoring/docker-compose.yml`
(prometheus.command list) and `docker compose up -d prometheus` to
recreate. Without that flag, k6 runs fine but workload metrics don't
land in Prom (the dashboard's workload-error panel stays empty for
the duration).
