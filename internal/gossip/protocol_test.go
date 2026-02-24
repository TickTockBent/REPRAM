package gossip

import (
	"context"
	"fmt"
	"sync"
	"testing"

	dto "github.com/prometheus/client_model/go"
)

// mockTransport is a test transport that can be configured to fail sends.
type mockTransport struct {
	mu             sync.Mutex
	failFor        map[NodeID]bool // peers whose sends should fail
	sendCount      map[NodeID]int
	messageHandler func(*Message) error
}

func newMockTransport() *mockTransport {
	return &mockTransport{
		failFor:   make(map[NodeID]bool),
		sendCount: make(map[NodeID]int),
	}
}

func (t *mockTransport) Start(ctx context.Context) error { return nil }
func (t *mockTransport) Stop() error                     { return nil }

func (t *mockTransport) Send(ctx context.Context, node *Node, msg *Message) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sendCount[node.ID]++
	if t.failFor[node.ID] {
		return fmt.Errorf("connection refused")
	}
	return nil
}

func (t *mockTransport) Broadcast(ctx context.Context, msg *Message) error {
	return fmt.Errorf("use Protocol.Broadcast")
}

func (t *mockTransport) SetMessageHandler(handler func(*Message) error) {
	t.messageHandler = handler
}

func (t *mockTransport) setFail(id NodeID, fail bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.failFor[id] = fail
}

func (t *mockTransport) getSendCount(id NodeID) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sendCount[id]
}

func newTestProtocol() (*Protocol, *mockTransport) {
	localNode := &Node{
		ID:       "local",
		Address:  "localhost",
		Port:     9090,
		HTTPPort: 8080,
		Enclave:  "default",
	}
	p := NewProtocol(localNode, 3, "")
	mt := newMockTransport()
	p.SetTransport(mt)
	return p, mt
}

func TestPeerEvictionAfterConsecutiveFailures(t *testing.T) {
	p, mt := newTestProtocol()

	deadPeer := &Node{ID: "dead-peer", Address: "dead", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	p.addPeer(deadPeer)
	mt.setFail("dead-peer", true)

	// Verify peer exists
	if len(p.GetPeers()) != 1 {
		t.Fatalf("expected 1 peer, got %d", len(p.GetPeers()))
	}

	// Ping should fail but not evict yet (failures < MaxPingFailures)
	for i := 1; i < MaxPingFailures; i++ {
		p.pingPeers(context.Background())
		if count := p.PeerFailureCount("dead-peer"); count != i {
			t.Fatalf("after %d pings, failure count = %d, want %d", i, count, i)
		}
		if len(p.GetPeers()) != 1 {
			t.Fatalf("peer should not be evicted after %d failures", i)
		}
	}

	// One more ping should trigger eviction
	p.pingPeers(context.Background())
	if len(p.GetPeers()) != 0 {
		t.Fatal("peer should be evicted after MaxPingFailures consecutive failures")
	}
}

func TestPongResetsPingFailures(t *testing.T) {
	p, mt := newTestProtocol()

	flakyPeer := &Node{ID: "flaky", Address: "flaky", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	p.addPeer(flakyPeer)
	mt.setFail("flaky", true)

	// Accumulate failures just under the threshold
	for i := 0; i < MaxPingFailures-1; i++ {
		p.pingPeers(context.Background())
	}

	if count := p.PeerFailureCount("flaky"); count != MaxPingFailures-1 {
		t.Fatalf("failure count = %d, want %d", count, MaxPingFailures-1)
	}

	// Simulate receiving a PONG — peer recovered
	pong := &Message{
		Type: MessageTypePong,
		From: "flaky",
		NodeInfo: &Node{
			ID:      "flaky",
			Enclave: "default",
		},
	}
	if err := p.handlePong(pong); err != nil {
		t.Fatalf("handlePong error: %v", err)
	}

	// Failure count should be reset
	if count := p.PeerFailureCount("flaky"); count != 0 {
		t.Fatalf("failure count after PONG = %d, want 0", count)
	}

	// Peer should still exist
	if len(p.GetPeers()) != 1 {
		t.Fatal("peer should not be evicted after PONG reset")
	}
}

func TestEvictedPeerRejoinsViaBootstrap(t *testing.T) {
	p, mt := newTestProtocol()

	peer := &Node{ID: "rejoiner", Address: "rejoiner", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	p.addPeer(peer)
	mt.setFail("rejoiner", true)

	// Evict via ping failures
	for i := 0; i < MaxPingFailures; i++ {
		p.pingPeers(context.Background())
	}
	if len(p.GetPeers()) != 0 {
		t.Fatal("peer should be evicted")
	}

	// Simulate peer coming back via addPeer (called during bootstrap)
	mt.setFail("rejoiner", false)
	p.addPeer(peer)

	if len(p.GetPeers()) != 1 {
		t.Fatal("peer should be re-added after bootstrap")
	}
	if count := p.PeerFailureCount("rejoiner"); count != 0 {
		t.Fatalf("failure count after re-add = %d, want 0", count)
	}
}

func TestHealthyPeerNotEvicted(t *testing.T) {
	p, _ := newTestProtocol()

	healthyPeer := &Node{ID: "healthy", Address: "healthy", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	p.addPeer(healthyPeer)

	// Ping many times — all succeed
	for i := 0; i < MaxPingFailures*3; i++ {
		p.pingPeers(context.Background())
	}

	if len(p.GetPeers()) != 1 {
		t.Fatal("healthy peer should not be evicted")
	}
	if count := p.PeerFailureCount("healthy"); count != 0 {
		t.Fatalf("failure count for healthy peer = %d, want 0", count)
	}
}

func TestMixedPeerEviction(t *testing.T) {
	p, mt := newTestProtocol()

	alive := &Node{ID: "alive", Address: "alive", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	dead := &Node{ID: "dead", Address: "dead", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	p.addPeer(alive)
	p.addPeer(dead)
	mt.setFail("dead", true)

	for i := 0; i < MaxPingFailures; i++ {
		p.pingPeers(context.Background())
	}

	peers := p.GetPeers()
	if len(peers) != 1 {
		t.Fatalf("expected 1 peer remaining, got %d", len(peers))
	}
	if peers[0].ID != "alive" {
		t.Fatalf("expected 'alive' peer to remain, got %s", peers[0].ID)
	}
}

// counterValue reads the current value from a Prometheus counter.
func counterValue(c interface{ Write(*dto.Metric) error }) float64 {
	var m dto.Metric
	c.Write(&m)
	return m.GetCounter().GetValue()
}

// gaugeValue reads the current value from a Prometheus gauge.
func gaugeValue(g interface{ Write(*dto.Metric) error }) float64 {
	var m dto.Metric
	g.Write(&m)
	return m.GetGauge().GetValue()
}

func TestEvictionMetrics(t *testing.T) {
	p, mt := newTestProtocol()
	p.EnableMetrics()

	peer := &Node{ID: "doomed", Address: "doomed", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	p.addPeer(peer)
	mt.setFail("doomed", true)

	// Verify active peers gauge
	if v := gaugeValue(p.metrics.peersActive); v != 1 {
		t.Fatalf("peersActive after addPeer = %v, want 1", v)
	}

	evictionsBefore := counterValue(p.metrics.peerEvictions)
	pingFailuresBefore := counterValue(p.metrics.pingFailures)

	// Evict the peer
	for i := 0; i < MaxPingFailures; i++ {
		p.pingPeers(context.Background())
	}

	// Check eviction counter incremented
	evictionsAfter := counterValue(p.metrics.peerEvictions)
	if evictionsAfter-evictionsBefore != 1 {
		t.Fatalf("peerEvictions delta = %v, want 1", evictionsAfter-evictionsBefore)
	}

	// Check ping failures counter incremented (MaxPingFailures times)
	pingFailuresAfter := counterValue(p.metrics.pingFailures)
	if pingFailuresAfter-pingFailuresBefore != float64(MaxPingFailures) {
		t.Fatalf("pingFailures delta = %v, want %d", pingFailuresAfter-pingFailuresBefore, MaxPingFailures)
	}

	// Check active peers gauge is now 0
	if v := gaugeValue(p.metrics.peersActive); v != 0 {
		t.Fatalf("peersActive after eviction = %v, want 0", v)
	}

	// Re-add the peer — should increment joins counter
	joinsBefore := counterValue(p.metrics.peerJoins)
	mt.setFail("doomed", false)
	p.addPeer(peer)

	joinsAfter := counterValue(p.metrics.peerJoins)
	if joinsAfter-joinsBefore != 1 {
		t.Fatalf("peerJoins delta = %v, want 1", joinsAfter-joinsBefore)
	}

	// Active peers gauge should be back to 1
	if v := gaugeValue(p.metrics.peersActive); v != 1 {
		t.Fatalf("peersActive after rejoin = %v, want 1", v)
	}
}
