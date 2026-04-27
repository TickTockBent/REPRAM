package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"errors"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"repram/internal/cluster"
	"repram/internal/gossip"
	"repram/internal/logging"
	"repram/internal/node"
	"repram/internal/storage"
	"repram/internal/trust"
)

// omegaLastRefreshGauge records the unix timestamp of the most recent
// successful signed-list refresh. The burn-in dashboard plots
// `time() - repram_omega_last_refresh_unix_seconds` to surface freshness.
// Stays at zero on private-network deployments (refresher never runs).
var omegaLastRefreshGauge = prometheus.NewGauge(prometheus.GaugeOpts{
	Name: "repram_omega_last_refresh_unix_seconds",
	Help: "Unix timestamp of the most recent successful omega root-list refresh (0 = never).",
})

func init() {
	prometheus.MustRegister(omegaLastRefreshGauge)
}

func main() {
	logging.Init()

	// Generate a unique node ID
	nodeID := os.Getenv("REPRAM_NODE_ID")
	if nodeID == "" {
		nodeID = fmt.Sprintf("node-%d", time.Now().UnixNano())
	}

	address := os.Getenv("REPRAM_ADDRESS")
	if address == "" {
		address = "localhost"
	}

	// Configuration: one name per setting, no aliases
	httpPort := envInt("REPRAM_HTTP_PORT", 8080)
	gossipPort := envInt("REPRAM_GOSSIP_PORT", 9090)
	replicationFactor := envInt("REPRAM_REPLICATION", 3)
	minTTL := envInt("REPRAM_MIN_TTL", 300)
	maxTTL := envInt("REPRAM_MAX_TTL", 86400)
	rateLimit := envInt("REPRAM_RATE_LIMIT", 100)
	maxStorageMB := envInt("REPRAM_MAX_STORAGE_MB", 0)    // 0 = unlimited
	writeTimeout := envInt("REPRAM_WRITE_TIMEOUT", 5)      // seconds
	clusterSecret := os.Getenv("REPRAM_CLUSTER_SECRET")
	trustProxy := strings.EqualFold(os.Getenv("REPRAM_TRUST_PROXY"), "true")
	enclave := os.Getenv("REPRAM_ENCLAVE") // default: "default"
	network := os.Getenv("REPRAM_NETWORK")
	if network == "" {
		network = "public"
	}

	// Resolve bootstrap peers.
	// REPRAM_PEERS are HTTP addresses (host:httpPort) since the bootstrap
	// handshake is an HTTP POST to /v1/bootstrap. Example: "node2:8080,node3:8080"
	var bootstrapNodes []string
	if peers := os.Getenv("REPRAM_PEERS"); peers != "" {
		bootstrapNodes = strings.Split(peers, ",")
		for i, n := range bootstrapNodes {
			bootstrapNodes[i] = strings.TrimSpace(n)
		}
	}

	// Signed-root-list bootstrap for the public network. See
	// docs/internal/REPRAM-2.1-Spec.md. This replaces the pre-2.1
	// unsigned DNS path; there is no fallback by design.
	var rootList *trust.SignedList
	if network == "public" && len(bootstrapNodes) == 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		list, err := resolveOmegaBootstrap(ctx)
		cancel()
		if err != nil {
			log.Fatalf("Omega bootstrap failed: %v", err)
		}
		rootList = list
		bootstrapNodes = append(bootstrapNodes, list.Nodes...)
	} else if network == "public" && len(bootstrapNodes) > 0 {
		// REPRAM_PEERS short-circuits omega resolution, which in turn
		// leaves IsRoot() false and causes /v1/bootstrap to 403. Fine
		// for local testing; wrong for a real public-network root node.
		// See docs/omega-operations.md for the guidance.
		logging.Warn("REPRAM_NETWORK=public with REPRAM_PEERS set: skipping omega verification. This node will not be recognized as a bootstrap root and will return 403 for /v1/bootstrap requests.")
	}

	clusterNode := cluster.NewClusterNode(nodeID, address, gossipPort, httpPort, replicationFactor, int64(maxStorageMB)*1024*1024, time.Duration(writeTimeout)*time.Second, clusterSecret, enclave)

	// Self-recognition: a node is a root iff its advertised address
	// appears in the signed list. Roots answer /v1/bootstrap; non-roots
	// return 403. Private-network deployments are never roots.
	applyRootStatus := func(list *trust.SignedList) {
		omegaLastRefreshGauge.SetToCurrentTime()
		selfAdvertised := fmt.Sprintf("%s:%d", address, gossipPort)
		isRoot := false
		for _, n := range list.Nodes {
			if n == selfAdvertised {
				isRoot = true
				break
			}
		}
		wasRoot := clusterNode.IsRoot()
		clusterNode.SetRoot(isRoot)
		if isRoot != wasRoot {
			if isRoot {
				logging.Info("Root status changed: this node is now a bootstrap root")
			} else {
				logging.Info("Root status changed: this node is no longer a bootstrap root")
			}
		}
	}
	if rootList != nil {
		applyRootStatus(rootList)
		selfAdvertised := fmt.Sprintf("%s:%d", address, gossipPort)
		if clusterNode.IsRoot() {
			logging.Info("Initial root status: bootstrap root (advertised as %s)", selfAdvertised)
		} else {
			logging.Info("Initial root status: not a root (advertised as %s); /v1/bootstrap returns 403", selfAdvertised)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := clusterNode.Start(ctx, bootstrapNodes); err != nil {
		log.Fatalf("Failed to start cluster node: %v", err)
	}

	// Start the omega refresh loop for public-network nodes. Keeps the
	// cached signed list fresh and recomputes root status on each refresh.
	if rootList != nil {
		pubkey, err := trust.DecodedOmegaPubkey()
		if err != nil {
			log.Fatalf("decode omega pubkey: %v", err)
		}
		refresher := trust.NewRefresher(trust.RefresherConfig{
			Pubkey:   pubkey,
			CacheDir: trust.DefaultCacheDir(),
			OnUpdate: applyRootStatus,
			OnError: func(err error) {
				logging.Warn("Omega refresh: %v", err)
			},
		}, rootList)
		go refresher.Run(ctx)
	}

	server := &HTTPServer{
		clusterNode: clusterNode,
		nodeID:      nodeID,
		network:     network,
		minTTL:      minTTL,
		maxTTL:      maxTTL,
		startTime:   time.Now(),
	}

	// Initialize security middleware
	securityMW := node.NewSecurityMiddleware(
		rateLimit,
		rateLimit*2, // burst = 2x rate
		10*1024*1024, // 10MB max request size
		trustProxy,
	)
	server.securityMW = securityMW

	peerCount := len(bootstrapNodes)
	logging.Info("REPRAM node online. Peers: %d. Network: %s", peerCount, network)
	logging.Info("  Node ID: %s", nodeID)
	logging.Info("  HTTP: :%d  Gossip: :%d  Enclave: %s", httpPort, gossipPort, clusterNode.Enclave())
	logging.Info("  Replication: %d  TTL range: %d-%ds  Write timeout: %ds", replicationFactor, minTTL, maxTTL, writeTimeout)
	if clusterSecret != "" {
		logging.Info("  Gossip authentication: HMAC-SHA256 (cluster secret configured)")
	} else {
		logging.Info("  Gossip authentication: none (open mode)")
	}

	// Create HTTP server for graceful shutdown support
	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", httpPort),
		Handler: server.Router(),
	}

	// Graceful shutdown: drain in-flight requests before exiting
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		logging.Info("Shutting down — draining in-flight requests...")

		// Give in-flight requests up to 10 seconds to complete
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()

		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logging.Warn("HTTP server shutdown error: %v", err)
		}

		securityMW.Close()
		clusterNode.Stop()
		cancel()
	}()

	if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("HTTP server error: %v", err)
	}
	logging.Info("Shutdown complete.")
}

// envInt reads an environment variable as int with a default fallback.
func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultVal
}

// resolveOmegaBootstrap fetches and verifies the signed root list from DNS,
// falling back to a previously-cached verified list if DNS is unreachable.
// Hard-fails only when neither source yields a currently-valid signed list —
// a node without a verified trust anchor must not join the public network.
func resolveOmegaBootstrap(ctx context.Context) (*trust.SignedList, error) {
	pubkey, err := trust.DecodedOmegaPubkey()
	if err != nil {
		return nil, fmt.Errorf("baked-in omega pubkey is invalid: %w", err)
	}

	cacheDir, usedLastResort := trust.ResolveCacheDir()
	if usedLastResort {
		logging.Warn("Using %s as cache directory; this typically requires root write access. Set REPRAM_CACHE_DIR for a writable location if refresh writes start failing.", cacheDir)
	}
	now := time.Now()

	list, fetchErr := trust.FetchSigned(ctx, trust.DNSConfig{}, pubkey, now)
	if fetchErr == nil {
		if err := trust.SaveCache(cacheDir, list); err != nil {
			logging.Warn("Failed to update omega cache at %s: %v (continuing)", cacheDir, err)
		}
		logging.Info("Omega bootstrap: verified signed root list (%d nodes, expires %s)",
			len(list.Nodes), time.Unix(list.Expires, 0).UTC().Format(time.RFC3339))
		return list, nil
	}

	logging.Warn("Omega DNS fetch failed: %v — trying cached list at %s", fetchErr, cacheDir)
	cached, cacheErr := trust.LoadCache(cacheDir)
	if cacheErr != nil {
		return nil, fmt.Errorf("dns: %v; cache: %w", fetchErr, cacheErr)
	}
	if cached == nil {
		return nil, fmt.Errorf("no DNS record and no cache available: %w", fetchErr)
	}
	if err := cached.Verify(pubkey, now); err != nil {
		return nil, fmt.Errorf("cached omega list invalid: %w (dns: %v)", err, fetchErr)
	}
	logging.Info("Omega bootstrap: using cached signed root list (%d nodes, expires %s)",
		len(cached.Nodes), time.Unix(cached.Expires, 0).UTC().Format(time.RFC3339))
	return cached, nil
}

// CORS middleware
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-TTL")
		w.Header().Set("Access-Control-Max-Age", "3600")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

type HTTPServer struct {
	clusterNode *cluster.ClusterNode
	nodeID      string
	network     string
	minTTL      int
	maxTTL      int
	startTime   time.Time
	securityMW  *node.SecurityMiddleware
}

func (s *HTTPServer) Router() *mux.Router {
	r := mux.NewRouter()

	// Apply middleware
	r.Use(corsMiddleware)
	r.Use(s.securityMW.Middleware)
	r.Use(node.MaxRequestSizeMiddleware(s.securityMW.MaxRequestSize()))
	r.Use(node.TimeoutMiddleware(30 * time.Second))

	// v1 API endpoints
	r.HandleFunc("/v1/data/{key}", s.putHandler).Methods("PUT", "OPTIONS")
	r.HandleFunc("/v1/data/{key}", s.getHandler).Methods("GET", "HEAD", "OPTIONS")
	r.HandleFunc("/v1/keys", s.keysHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/health", s.healthHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/status", s.statusHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/metrics", promhttp.Handler().ServeHTTP).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/topology", s.topologyHandler).Methods("GET", "OPTIONS")

	// Internal gossip endpoints
	r.HandleFunc("/v1/gossip/message", s.gossipHandler).Methods("POST", "OPTIONS")
	r.HandleFunc("/v1/bootstrap", s.bootstrapHandler).Methods("POST", "OPTIONS")

	return r
}

func (s *HTTPServer) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "healthy",
		"node_id": s.nodeID,
		"network": s.network,
		"enclave": s.clusterNode.Enclave(),
	})
}

func (s *HTTPServer) statusHandler(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "healthy",
		"node_id":    s.nodeID,
		"network":    s.network,
		"enclave":    s.clusterNode.Enclave(),
		"uptime":     time.Since(s.startTime).String(),
		"goroutines": runtime.NumGoroutine(),
		"memory": map[string]interface{}{
			"alloc":       m.Alloc,
			"total_alloc": m.TotalAlloc,
			"sys":         m.Sys,
			"num_gc":      m.NumGC,
		},
	})
}

func (s *HTTPServer) topologyHandler(w http.ResponseWriter, r *http.Request) {
	peers := s.clusterNode.Topology()

	type peerInfo struct {
		ID       string `json:"id"`
		Address  string `json:"address"`
		HTTPPort int    `json:"http_port"`
		Enclave  string `json:"enclave"`
	}

	peerList := make([]peerInfo, 0, len(peers))
	for _, p := range peers {
		peerList = append(peerList, peerInfo{
			ID:       string(p.ID),
			Address:  p.Address,
			HTTPPort: p.HTTPPort,
			Enclave:  p.Enclave,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"node_id": s.nodeID,
		"enclave": s.clusterNode.Enclave(),
		"peers":   peerList,
	})
}

func (s *HTTPServer) putHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	// TTL from header or query param
	ttl := 3600 // Default 1 hour
	if ttlStr := r.URL.Query().Get("ttl"); ttlStr != "" {
		if parsed, err := strconv.Atoi(ttlStr); err == nil && parsed > 0 {
			ttl = parsed
		}
	} else if ttlHeader := r.Header.Get("X-TTL"); ttlHeader != "" {
		if parsed, err := strconv.Atoi(ttlHeader); err == nil && parsed > 0 {
			ttl = parsed
		}
	}

	// Enforce TTL bounds
	if ttl < s.minTTL {
		ttl = s.minTTL
	}
	if ttl > s.maxTTL {
		ttl = s.maxTTL
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.clusterNode.Put(ctx, key, body, time.Duration(ttl)*time.Second); err != nil {
		if errors.Is(err, storage.ErrStoreFull) {
			http.Error(w, "Node storage capacity exceeded", http.StatusInsufficientStorage)
			return
		}
		if errors.Is(err, cluster.ErrQuorumTimeout) {
			// Data is stored locally and will propagate via gossip.
			// 202 Accepted signals "written, replication in progress."
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprintf(w, "Accepted (quorum pending)")
			return
		}
		http.Error(w, fmt.Sprintf("Write failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "OK")
}

func (s *HTTPServer) getHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]

	data, createdAt, originalTTL, exists := s.clusterNode.GetWithMetadata(key)
	if !exists {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	elapsed := time.Since(createdAt)
	remainingTTL := originalTTL - elapsed
	if remainingTTL < 0 {
		remainingTTL = 0
	}

	w.Header().Set("X-Created-At", createdAt.Format(time.RFC3339))
	w.Header().Set("X-Original-TTL", strconv.Itoa(int(originalTTL.Seconds())))
	w.Header().Set("X-Remaining-TTL", strconv.Itoa(int(remainingTTL.Seconds())))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

func (s *HTTPServer) keysHandler(w http.ResponseWriter, r *http.Request) {
	keys := s.clusterNode.Scan()

	// Optional prefix filter
	if prefix := r.URL.Query().Get("prefix"); prefix != "" {
		var filtered []string
		for _, k := range keys {
			if strings.HasPrefix(k, prefix) {
				filtered = append(filtered, k)
			}
		}
		keys = filtered
	}

	// Sort for stable cursor-based pagination
	sort.Strings(keys)

	// Cursor: skip keys <= cursor value (cursor is the last key from previous page)
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		idx := sort.SearchStrings(keys, cursor)
		// Skip past the cursor key itself
		if idx < len(keys) && keys[idx] == cursor {
			idx++
		}
		keys = keys[idx:]
	}

	// Limit: cap the number of returned keys
	limit := 0
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	var nextCursor string
	if limit > 0 && len(keys) > limit {
		nextCursor = keys[limit-1]
		keys = keys[:limit]
	}

	resp := map[string]interface{}{
		"keys": keys,
	}
	if nextCursor != "" {
		resp["next_cursor"] = nextCursor
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *HTTPServer) verifyGossipSignature(w http.ResponseWriter, r *http.Request, body []byte) bool {
	secret := s.clusterNode.ClusterSecret()
	if secret == "" {
		return true // open mode
	}
	sig := r.Header.Get("X-Repram-Signature")
	if sig == "" {
		http.Error(w, "Missing signature", http.StatusForbidden)
		return false
	}
	if !gossip.VerifyBody(secret, body, sig) {
		http.Error(w, "Invalid signature", http.StatusForbidden)
		return false
	}
	return true
}

func (s *HTTPServer) gossipHandler(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	if !s.verifyGossipSignature(w, r, body) {
		return
	}

	var simpleMsg gossip.SimpleMessage
	if err := json.Unmarshal(body, &simpleMsg); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	gossipMsg := &gossip.Message{
		Type:      gossip.MessageType(simpleMsg.Type),
		From:      gossip.NodeID(simpleMsg.From),
		To:        gossip.NodeID(simpleMsg.To),
		Key:       simpleMsg.Key,
		Data:      simpleMsg.Data,
		TTL:       int(simpleMsg.TTL),
		Timestamp: time.Unix(simpleMsg.Timestamp, 0),
		MessageID: simpleMsg.MessageID,
	}

	if simpleMsg.NodeInfo != nil {
		enclave := simpleMsg.NodeInfo.Enclave
		if enclave == "" {
			enclave = "default"
		}
		gossipMsg.NodeInfo = &gossip.Node{
			ID:       gossip.NodeID(simpleMsg.NodeInfo.ID),
			Address:  simpleMsg.NodeInfo.Address,
			Port:     simpleMsg.NodeInfo.Port,
			HTTPPort: simpleMsg.NodeInfo.HTTPPort,
			Enclave:  enclave,
		}
	}

	if err := s.clusterNode.HandleGossipMessage(gossipMsg); err != nil {
		http.Error(w, fmt.Sprintf("Gossip error: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (s *HTTPServer) bootstrapHandler(w http.ResponseWriter, r *http.Request) {
	// Only roots answer bootstrap requests. On the public network a node is
	// a root iff its advertised address is in the current signed omega list
	// (see resolveOmegaBootstrap). On private networks no one is a root
	// under this gate — peer discovery is driven by REPRAM_PEERS directly.
	if s.network == "public" && !s.clusterNode.IsRoot() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "not a bootstrap root"})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	if !s.verifyGossipSignature(w, r, body) {
		return
	}

	var req gossip.BootstrapRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	resp := s.clusterNode.HandleBootstrap(&req)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
