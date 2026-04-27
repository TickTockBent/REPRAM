package gossip

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

// TestHandleBootstrap_ResponseIncludesSelf locks in #82: the seed must
// include its own localNode in the response. That's how a joiner
// bootstrapping from a single seed learns about the seed itself; if the
// seed strips it, a single-seed bootstrap discovers no peers at all.
// Duplicate-discovery (the F4 symptom) is fixed on the caller via dedup,
// not by stripping self here.
func TestHandleBootstrap_ResponseIncludesSelf(t *testing.T) {
	p, _ := newTestProtocol()
	p.addPeer(&Node{ID: "peer-x", Address: "x", Port: 9090, HTTPPort: 8080, Enclave: "default"})

	resp := p.HandleBootstrap(&BootstrapRequest{
		NodeID:     "joiner",
		Address:    "joiner",
		GossipPort: 9090,
		HTTPPort:   8080,
		Enclave:    "default",
	})

	foundSelf := false
	for _, peer := range resp.Peers {
		if peer.ID == p.localNode.ID {
			foundSelf = true
		}
	}
	if !foundSelf {
		t.Fatalf("response does not include self; joiner with one seed would never learn about it")
	}
}

// TestBootstrap_ContactsAllSeeds locks in #82 (F3): the bootstrap loop
// must reach every seed even after one succeeds. Otherwise later seeds
// don't register the joiner until topology sync, producing asymmetric
// topology.
func TestBootstrap_ContactsAllSeeds(t *testing.T) {
	hits := make(map[string]int)
	makeSeed := func(name string, peerToReport *Node) *httptest.Server {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits[name]++
			resp := BootstrapResponse{Success: true, Peers: []*Node{peerToReport}}
			_ = json.NewEncoder(w).Encode(resp)
		}))
		t.Cleanup(s.Close)
		return s
	}

	peerA := &Node{ID: "peer-a", Address: "1.1.1.1", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	peerB := &Node{ID: "peer-b", Address: "2.2.2.2", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	peerC := &Node{ID: "peer-c", Address: "3.3.3.3", Port: 9090, HTTPPort: 8080, Enclave: "default"}

	srvA := makeSeed("a", peerA)
	srvB := makeSeed("b", peerB)
	srvC := makeSeed("c", peerC)

	p, _ := newTestProtocol()
	seeds := []string{
		stripScheme(srvA.URL),
		stripScheme(srvB.URL),
		stripScheme(srvC.URL),
	}

	if err := p.Bootstrap(context.Background(), seeds); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}

	for _, name := range []string{"a", "b", "c"} {
		if hits[name] != 1 {
			t.Fatalf("seed %s hit %d times, want 1 (loop should contact every seed)", name, hits[name])
		}
	}

	got := nodeIDs(p.GetPeers())
	want := []string{"peer-a", "peer-b", "peer-c"}
	sort.Strings(got)
	if !equalStringSlices(got, want) {
		t.Fatalf("peers = %v, want %v", got, want)
	}
}

// TestBootstrap_DedupesPeersAcrossSeeds locks in #82 (F4): when multiple
// seeds report the same peer, addPeer is called once and "Discovered
// peer X" is logged once.
func TestBootstrap_DedupesPeersAcrossSeeds(t *testing.T) {
	shared := &Node{ID: "shared", Address: "9.9.9.9", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	makeSeed := func() *httptest.Server {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			resp := BootstrapResponse{Success: true, Peers: []*Node{shared}}
			_ = json.NewEncoder(w).Encode(resp)
		}))
		t.Cleanup(s.Close)
		return s
	}
	srv1 := makeSeed()
	srv2 := makeSeed()
	srv3 := makeSeed()

	p, _ := newTestProtocol()
	if err := p.Bootstrap(context.Background(), []string{
		stripScheme(srv1.URL),
		stripScheme(srv2.URL),
		stripScheme(srv3.URL),
	}); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}

	peers := p.GetPeers()
	if len(peers) != 1 {
		t.Fatalf("expected 1 deduped peer, got %d", len(peers))
	}
	if peers[0].ID != "shared" {
		t.Fatalf("peer = %s, want shared", peers[0].ID)
	}
}

// TestBootstrap_FiltersSelfFromResponse locks in #82 (F4) on the caller
// side: even if a buggy or older seed includes localNode in its response,
// the caller must filter it before adding to its peer set.
func TestBootstrap_FiltersSelfFromResponse(t *testing.T) {
	p, _ := newTestProtocol()
	selfMimic := &Node{ID: p.localNode.ID, Address: "evil", Port: 1, HTTPPort: 1, Enclave: "default"}
	realPeer := &Node{ID: "real", Address: "real", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := BootstrapResponse{Success: true, Peers: []*Node{selfMimic, realPeer}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	if err := p.Bootstrap(context.Background(), []string{stripScheme(srv.URL)}); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}

	for _, peer := range p.GetPeers() {
		if peer.ID == p.localNode.ID {
			t.Fatalf("self leaked into peer set via bootstrap response")
		}
	}
}

// TestBootstrap_ContinuesAfterSeedFailure locks in #82 (F3): if one seed
// fails (404, timeout, etc.), the remaining seeds are still contacted.
func TestBootstrap_ContinuesAfterSeedFailure(t *testing.T) {
	good := &Node{ID: "good", Address: "good", Port: 9090, HTTPPort: 8080, Enclave: "default"}
	srvBad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "broken seed", http.StatusInternalServerError)
	}))
	t.Cleanup(srvBad.Close)
	srvGood := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := BootstrapResponse{Success: true, Peers: []*Node{good}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srvGood.Close)

	p, _ := newTestProtocol()
	if err := p.Bootstrap(context.Background(), []string{
		stripScheme(srvBad.URL),
		stripScheme(srvGood.URL),
	}); err != nil {
		t.Fatalf("bootstrap should not error when at least one seed succeeds: %v", err)
	}
	if peers := p.GetPeers(); len(peers) != 1 || peers[0].ID != "good" {
		t.Fatalf("expected to discover peer 'good' from the working seed, got %v", nodeIDs(peers))
	}
}

// TestAddPeer_RejectsSelf locks in #87 (F7): addPeer must refuse to add
// the local node and return false. This is the single chokepoint that
// keeps self out of every iterator that touches p.peers.
func TestAddPeer_RejectsSelf(t *testing.T) {
	p, _ := newTestProtocol()

	added := p.addPeer(p.localNode)
	if added {
		t.Fatalf("addPeer(localNode) returned true; expected false (self should be rejected)")
	}
	if peers := p.GetPeers(); len(peers) != 0 {
		t.Fatalf("expected 0 peers after self-add attempt, got %d: %v", len(peers), nodeIDs(peers))
	}
}

// TestAddPeer_AcceptsOthers verifies the rejection is specific to self
// and does not regress the normal addPeer path.
func TestAddPeer_AcceptsOthers(t *testing.T) {
	p, _ := newTestProtocol()
	other := &Node{ID: "other", Address: "10.0.0.1", Port: 9090, HTTPPort: 8080, Enclave: "default"}

	added := p.addPeer(other)
	if !added {
		t.Fatalf("addPeer(other) returned false; expected true")
	}
	if peers := p.GetPeers(); len(peers) != 1 || peers[0].ID != "other" {
		t.Fatalf("expected [other], got %v", nodeIDs(peers))
	}
}

// TestBootstrap_SkipsSelfInSeedList locks in #87 option C: when the seed
// list contains the bootstrapping node's own advertised address (which is
// always true for omega-listed roots), the loop must skip it rather than
// POST a self-bootstrap. The httptest server here would record the hit if
// the loop didn't skip.
func TestBootstrap_SkipsSelfInSeedList(t *testing.T) {
	otherHits := 0
	srvOther := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits++
		resp := BootstrapResponse{Success: true, Peers: []*Node{
			{ID: "other", Address: "10.0.0.2", Port: 9090, HTTPPort: 8080, Enclave: "default"},
		}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srvOther.Close)

	p, _ := newTestProtocol()
	// Self-advertised address per #82 spec: address:HTTPPort
	selfAdvertised := fmt.Sprintf("%s:%d", p.localNode.Address, p.localNode.HTTPPort)

	if err := p.Bootstrap(context.Background(), []string{
		selfAdvertised,             // would self-bootstrap if not skipped
		stripScheme(srvOther.URL),  // real seed
	}); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}

	if otherHits != 1 {
		t.Fatalf("real seed hit %d times; expected 1", otherHits)
	}
	got := nodeIDs(p.GetPeers())
	if len(got) != 1 || got[0] != "other" {
		t.Fatalf("peers = %v, want [other]", got)
	}
}

// TestSelfBootstrapResponseDoesNotPolluteMap reproduces the F7 burn-in
// scenario in isolation: a seed sends back a response that includes the
// joiner's own ID (because the seed addPeer'd it then included it in the
// response). Even with the option-C skip in place, this defends against
// a non-omega seed list where self might still slip through, or any other
// path where a seed legitimately echoes the joiner's ID. addPeer's
// self-filter must catch it.
func TestSelfBootstrapResponseDoesNotPolluteMap(t *testing.T) {
	p, _ := newTestProtocol()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Buggy / hostile seed includes the joiner's own ID in its response
		resp := BootstrapResponse{Success: true, Peers: []*Node{
			{ID: p.localNode.ID, Address: "evil", Port: 1, HTTPPort: 1, Enclave: "default"},
			{ID: "real", Address: "real", Port: 9090, HTTPPort: 8080, Enclave: "default"},
		}}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	if err := p.Bootstrap(context.Background(), []string{stripScheme(srv.URL)}); err != nil {
		t.Fatalf("bootstrap failed: %v", err)
	}

	for _, peer := range p.GetPeers() {
		if peer.ID == p.localNode.ID {
			t.Fatalf("self leaked into peer set despite caller-side filter and addPeer self-filter")
		}
	}
}

// stripScheme converts httptest's "http://127.0.0.1:port" to "127.0.0.1:port"
// so the result matches what the omega signed-list parser produces.
func stripScheme(url string) string {
	const prefix = "http://"
	if len(url) >= len(prefix) && url[:len(prefix)] == prefix {
		return url[len(prefix):]
	}
	return url
}

func nodeIDs(nodes []*Node) []string {
	ids := make([]string, 0, len(nodes))
	for _, n := range nodes {
		ids = append(ids, string(n.ID))
	}
	return ids
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
