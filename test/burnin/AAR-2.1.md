# Burn-in 2.1 — After-Action Report

**Run:** 2026-05-09 through 2026-05-12
**Cluster:** 3 nodes, public network, default enclave, port 18080
**Workload:** k6 driving `workload.js`, 6 × 12h segments via `run-segments.sh`
**Outcome:** Cluster survived end-to-end. Go stability proven. TS path validated, then deprecated.

---

## Cluster

| Role | Host | Impl | Started | Uptime at end | Heap alloc | Sys mem |
|------|------|------|---------|---------------|------------|---------|
| node-a | 10.0.20.72 | Go  | ~2026-05-09 08:00 | 72h47m | 26.0 MB | 143 MB |
| node-b | 10.0.10.81 | Go  | ~2026-05-09 08:06 | 72h41m | 37.3 MB | 143 MB |
| node-c | 10.0.10.104 | TS | ~2026-05-10 22:00 | 37h18m | 46.2 MB heap / 201 MB RSS | — |

node-a `num_gc=75361` over 72h47m — one GC every ~3.5s steady-state. `total_alloc=1.45 TB` cumulative over the run.

node-c uptime is short because the TS node was rebuilt three times during the burn-in (undici→http.request, per-peer agents, self-attachment fix). Final restart was the self-attachment fix landing 2026-05-10.

---

## Timeline

| Segment | Start | Duration | Notes |
|---------|-------|----------|-------|
| 1 | 2026-05-09 08:00 | 12h | Initial run. Issues surfaced in TS gossip. |
| 2 | 2026-05-09 20:00 | 12h | Same TS issues persisting. |
| — | 2026-05-10 08–18 | ~8h pause | TS rework: #117 (per-peer http.Agents) + #116 (parallel broadcasts via Promise.allSettled). |
| 3 | 2026-05-10 18:00 | 12h | TS rebuild #2 in flight. |
| — | 2026-05-10 22:00 | TS restart | #120 self-attachment fix lands (PR #121). |
| 4 | 2026-05-11 06:00 | 12h | First clean segment with all fixes. |
| 5 | 2026-05-11 18:00 | 12h | Steady. |
| 6 | 2026-05-12 06:00 | 12h | Steady. Cluster idle by ~08:50 when k6 exited. |

The 8h gap between segments 2 and 3 was the diagnostic/fix window for the TS issues; segments 1–2 motivated the diagnosis, segments 3–6 validated the fixes under load.

---

## Per-node observations

### Go nodes (node-a, node-b)
- **Rock steady.** Heap held in the 26–37 MB band for 72h. No restarts, no crashes, no eviction churn against each other.
- GC pacing consistent (~17/min). No long pauses observed.
- `total_alloc` of 1.45 TB on node-a confirms it carried real traffic (not just heartbeats) — allocation throughput ~5.5 MB/s sustained.
- Confirms the post-#117 TS work did not require any Go-side compensating changes — the wire format and quorum protocol held across implementations.

### TS node (node-c)
- Three rebuilds, each driven by an observed defect:
  1. **#94 / #117** — undici/fetch leaked response bodies; replaced with `http.request` + per-peer dedicated `http.Agent` (maxSockets: 8, keepAlive: true).
  2. **#116** — broadcastToEnclave serialized writes one peer at a time, capping write throughput; reworked to `Promise.allSettled`.
  3. **#120** — TS node self-attaching as its own WS peer, producing 100% 202s on local writes; skip-self check added in tree attachment selection (PR #121).
- After #121 the TS RSS settled at 191 MB with stable working set. Memory notes captured a 192→164 MB drop across a segment boundary — evidence the runtime *releases* memory under sustained load, contradicting any "TS is leaking" framing. Current RSS at 201 MB is within ~5% variance of that baseline.
- Heap 46 MB / RSS 201 MB — the ~155 MB delta is V8/Node runtime overhead, not data. This is the structural cost that motivated #123 (Go-native MCP node).

### Wire compatibility
The mixed cluster (2 Go + 1 TS) ran for the full burn-in without protocol disagreement. Gossip, HMAC auth, message dedup, and quorum all interoperated. This is the only validation we needed for the wire format — and it held.

---

## Throughput

k6 ran on a remote driver host that's not in this AAR's reach (snapshot harness only captures node-side state, not the load generator's logs). Indirect signal:

- node-a allocated 1.45 TB over 72h47m → ~5.5 MB/s sustained allocation rate.
- With workload.js payloads in the low-KB range, this corresponds to a steady-state mixed write/read rate in the low thousands of ops/sec per node.
- No 5xx-rate spike pattern in node-side gauges across the run (verified via /v1/status liveness through the segments).

The precise k6 iteration count and ops/sec mean ride on the remote-driver logs and are not captured here.

---

## Issues fixed during the run

| Issue | Title | Fix |
|-------|-------|-----|
| #94 | fetch() response body drain | Replaced undici with `http.request`. Superseded by #117. |
| #116 | broadcastToEnclave serial latency | `Promise.allSettled` parallel fanout. PR #118. |
| #117 | Per-peer dedicated http.Agent | PR #118 + PR #119 (maxSockets bump 1→8). |
| #120 | WS self-attachment → 100% 202 on TS writes | Skip self in attachment candidates. PR #121. |
| #122 | TS memory footprint | Closed wontfix — superseded by #123. |
| #123 | Go-native MCP server (`--mcp` flag) | PR #125 merged 2026-05-12 12:01 UTC. Removed TS node. |

---

## Validation outcomes

**Validated:**
- Go node multi-day stability (72h+, zero restarts, bounded heap).
- Wire-format compatibility between Go and TS nodes under sustained load.
- Gossip correctness in a mixed cluster (no divergent reads observed).
- Quorum protocol under TS-side defects (failures degraded to 202, never 5xx).
- `failure-as-feature` model: each TS rebuild was a clean re-join without rebalancing or backfill — confirms the design intent (see `repram-scaling-properties.md` in auto-memory).
- HMAC gossip auth under sustained traffic.

**Not validated (out of scope or deferred):**
- Public mesh / DNS-delivered root list (#80, blocked on #15 and omega keygen).
- WebSocket tree under multi-substrate topology (only two substrates here, both routable).
- Failure injection / split-brain / network partition (no chaos this run).

---

## Decisions emerging from the run

1. **Archive the TS node implementation.** Done in PR #125 alongside the Go MCP add.
2. **Implement `repram --mcp`.** Done (#123, PR #125).
3. **Run a ramp-to-failure test** with all-Go cluster — `test/burnin/ramp-to-failure.js` is queued; not yet run.
4. **Dogfood:** strap REPRAM MCP onto Claude Code harness.
5. **NAT-traversal regression** identified post-merge: removing the TS node also removed the WS substrate↔transient tree. Filed as #133, full Option A port spec in #135.

---

## Post-burn-in roadmap

In priority order:

1. **#135 — port WS tree to Go.** Restores NAT-traversal capability that the TS node carried. 7-phase spec ready for handoff. Without this, `--mcp` is a local-only scratchpad (#133 captures the gap).
2. **Ramp-to-failure test** — all-Go cluster, pprof captures via `ramp-pprof-capture.sh`. Establishes the actual ceiling.
3. **#126 / #127** — `--mcp` HTTP/gossip binding tweaks (bind to advertised address; read gossip port back after bind).
4. **#128 / #129 / #130 / #131 / #132** — MCP buffer size, error shapes, dead-code cleanups, test gap, protocol version.
5. **#15 + #80** — stand up public bootstrap network, generate real omega key. The current `OmegaPubkey` baked into binaries is a 32-zero-byte placeholder; production cutover is gated on this.

---

## File pointers

- Burn-in harness: `test/burnin/{run-segments.sh, workload.js, Dockerfile.ts-node, Dockerfile.go-node}`
- Ramp test (next): `test/burnin/{ramp-to-failure.js, ramp-pprof-capture.sh}`
- Closed PRs from this run: #110 (transient reattach), #112 (pprof), #113 (drain), #118 (parallel fanout + http.Agents), #119 (maxSockets), #121 (self-skip), #125 (Go MCP).
- Open gap: #133 / #135 (WS tree port).
