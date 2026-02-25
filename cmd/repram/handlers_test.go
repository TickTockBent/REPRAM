package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"repram/internal/cluster"
	"repram/internal/node"
)

// newTestServer creates an HTTPServer backed by a single-node cluster
// suitable for handler-level tests. No gossip, no network.
func newTestServer(t *testing.T) (*HTTPServer, func()) {
	t.Helper()

	cn := cluster.NewClusterNode(
		"test-node", "localhost", 0, 0,
		1,    // replicationFactor=1 → quorum=1 (local write sufficient)
		0,    // unlimited storage
		5*time.Second,
		"",   // no cluster secret
		"default",
	)

	ctx, cancel := context.WithCancel(context.Background())
	if err := cn.Start(ctx, nil); err != nil {
		t.Fatalf("failed to start cluster node: %v", err)
	}

	securityMW := node.NewSecurityMiddleware(1000, 2000, 10*1024*1024, false)

	server := &HTTPServer{
		clusterNode: cn,
		nodeID:      "test-node",
		network:     "private",
		minTTL:      300,
		maxTTL:      86400,
		startTime:   time.Now(),
		securityMW:  securityMW,
	}

	cleanup := func() {
		securityMW.Close()
		cn.Stop()
		cancel()
	}

	return server, cleanup
}

// --- PUT handler tests ---

func TestPutReturns201(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("PUT", "/v1/data/mykey", strings.NewReader("hello"))
	req.Header.Set("X-TTL", "600")
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestPutTTLFromQueryParam(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("PUT", "/v1/data/qkey?ttl=600", strings.NewReader("data"))
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}

	// Verify it was stored
	getReq := httptest.NewRequest("GET", "/v1/data/qkey", nil)
	getW := httptest.NewRecorder()
	server.Router().ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("GET after PUT: expected 200, got %d", getW.Code)
	}
	if getW.Body.String() != "data" {
		t.Fatalf("GET body = %q, want %q", getW.Body.String(), "data")
	}
}

func TestPutTTLClampedToMin(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	// Request TTL=1 (below minTTL=300) — should be clamped, not rejected
	req := httptest.NewRequest("PUT", "/v1/data/clampkey", strings.NewReader("data"))
	req.Header.Set("X-TTL", "1")
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}

	// Verify the data is stored and TTL was clamped to minTTL (300)
	getReq := httptest.NewRequest("GET", "/v1/data/clampkey", nil)
	getW := httptest.NewRecorder()
	server.Router().ServeHTTP(getW, getReq)

	originalTTL := getW.Header().Get("X-Original-TTL")
	if originalTTL != "300" {
		t.Fatalf("X-Original-TTL = %q, want %q (clamped to minTTL)", originalTTL, "300")
	}
}

func TestPutMalformedTTLUsesDefault(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("PUT", "/v1/data/badttl", strings.NewReader("data"))
	req.Header.Set("X-TTL", "not-a-number")
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	// Should succeed — malformed TTL falls through to default (3600), clamped to min/max
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func TestPutNegativeTTLUsesDefault(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("PUT", "/v1/data/negttl", strings.NewReader("data"))
	req.Header.Set("X-TTL", "-100")
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	// Negative TTL fails the `parsed > 0` check, so default (3600) is used
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}
}

func TestPutEmptyBody(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("PUT", "/v1/data/emptykey", strings.NewReader(""))
	req.Header.Set("X-TTL", "600")
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	// Empty body is valid — store empty bytes
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}

	getReq := httptest.NewRequest("GET", "/v1/data/emptykey", nil)
	getW := httptest.NewRecorder()
	server.Router().ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("GET after PUT empty: expected 200, got %d", getW.Code)
	}
	if getW.Body.Len() != 0 {
		t.Fatalf("expected empty body, got %d bytes", getW.Body.Len())
	}
}

// --- GET handler tests ---

func TestGetNonexistentKey(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/v1/data/noexist", nil)
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetReturnsMetadataHeaders(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	// Store a key
	putReq := httptest.NewRequest("PUT", "/v1/data/metakey", strings.NewReader("payload"))
	putReq.Header.Set("X-TTL", "600")
	putW := httptest.NewRecorder()
	server.Router().ServeHTTP(putW, putReq)

	// Retrieve it
	getReq := httptest.NewRequest("GET", "/v1/data/metakey", nil)
	getW := httptest.NewRecorder()
	server.Router().ServeHTTP(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", getW.Code)
	}

	// Check metadata headers
	if getW.Header().Get("X-Created-At") == "" {
		t.Error("missing X-Created-At header")
	}
	if getW.Header().Get("X-Original-TTL") != "600" {
		t.Errorf("X-Original-TTL = %q, want %q", getW.Header().Get("X-Original-TTL"), "600")
	}
	if getW.Header().Get("X-Remaining-TTL") == "" {
		t.Error("missing X-Remaining-TTL header")
	}
	if getW.Header().Get("Content-Type") != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want %q", getW.Header().Get("Content-Type"), "application/octet-stream")
	}
	if getW.Header().Get("Content-Length") != "7" {
		t.Errorf("Content-Length = %q, want %q", getW.Header().Get("Content-Length"), "7")
	}
}

func TestHeadReturnsHeadersNoBody(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	// Store
	putReq := httptest.NewRequest("PUT", "/v1/data/headkey", strings.NewReader("payload"))
	putReq.Header.Set("X-TTL", "600")
	putW := httptest.NewRecorder()
	server.Router().ServeHTTP(putW, putReq)

	// HEAD request
	headReq := httptest.NewRequest("HEAD", "/v1/data/headkey", nil)
	headW := httptest.NewRecorder()
	server.Router().ServeHTTP(headW, headReq)

	if headW.Code != http.StatusOK {
		t.Fatalf("HEAD: expected 200, got %d", headW.Code)
	}
	if headW.Header().Get("X-Remaining-TTL") == "" {
		t.Error("HEAD: missing X-Remaining-TTL header")
	}
	// Note: httptest.NewRecorder doesn't strip body for HEAD (real http.Server does).
	// Verify Content-Length is set correctly — the real server handles body suppression.
	if headW.Header().Get("Content-Length") != "7" {
		t.Errorf("HEAD: Content-Length = %q, want %q", headW.Header().Get("Content-Length"), "7")
	}
}

func TestHeadNonexistentKey(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("HEAD", "/v1/data/missing", nil)
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("HEAD missing key: expected 404, got %d", w.Code)
	}
}

// --- Keys handler tests ---

func TestKeysEmpty(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/v1/keys", nil)
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string][]string
	json.NewDecoder(w.Body).Decode(&resp)

	if len(resp["keys"]) != 0 {
		t.Fatalf("expected empty keys list, got %v", resp["keys"])
	}
}

func TestKeysPrefixFilter(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	// Store keys with different prefixes (no slashes — mux {key} is one path segment)
	for _, key := range []string{"app-foo", "app-bar", "other-baz"} {
		req := httptest.NewRequest("PUT", "/v1/data/"+key, strings.NewReader("data"))
		req.Header.Set("X-TTL", "600")
		w := httptest.NewRecorder()
		server.Router().ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("PUT %s: expected 201, got %d", key, w.Code)
		}
	}

	// Filter by prefix
	req := httptest.NewRequest("GET", "/v1/keys?prefix=app-", nil)
	w := httptest.NewRecorder()
	server.Router().ServeHTTP(w, req)

	var resp map[string][]string
	json.NewDecoder(w.Body).Decode(&resp)

	if len(resp["keys"]) != 2 {
		t.Fatalf("expected 2 keys with prefix app-, got %d: %v", len(resp["keys"]), resp["keys"])
	}

	for _, k := range resp["keys"] {
		if !strings.HasPrefix(k, "app-") {
			t.Errorf("key %q does not have prefix app-", k)
		}
	}
}

// --- Health / status handler tests ---

func TestHealthEndpoint(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/v1/health", nil)
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["status"] != "healthy" {
		t.Errorf("status = %v, want healthy", resp["status"])
	}
	if resp["node_id"] != "test-node" {
		t.Errorf("node_id = %v, want test-node", resp["node_id"])
	}
}

func TestStatusEndpoint(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/v1/status", nil)
	w := httptest.NewRecorder()

	server.Router().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["uptime"] == nil {
		t.Error("missing uptime field")
	}
	if resp["memory"] == nil {
		t.Error("missing memory field")
	}
}

// --- Overwrite behavior ---

func TestPutOverwriteReplacesData(t *testing.T) {
	server, cleanup := newTestServer(t)
	defer cleanup()

	// Write v1
	req := httptest.NewRequest("PUT", "/v1/data/overkey", strings.NewReader("version1"))
	req.Header.Set("X-TTL", "600")
	w := httptest.NewRecorder()
	server.Router().ServeHTTP(w, req)

	// Write v2 (overwrite)
	req2 := httptest.NewRequest("PUT", "/v1/data/overkey", strings.NewReader("version2"))
	req2.Header.Set("X-TTL", "600")
	w2 := httptest.NewRecorder()
	server.Router().ServeHTTP(w2, req2)

	if w2.Code != http.StatusCreated {
		t.Fatalf("overwrite: expected 201, got %d", w2.Code)
	}

	// Read — should get v2
	getReq := httptest.NewRequest("GET", "/v1/data/overkey", nil)
	getW := httptest.NewRecorder()
	server.Router().ServeHTTP(getW, getReq)

	if getW.Body.String() != "version2" {
		t.Fatalf("after overwrite: got %q, want %q", getW.Body.String(), "version2")
	}
}
