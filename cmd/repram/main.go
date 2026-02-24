package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"errors"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"repram/internal/cluster"
	"repram/internal/gossip"
	"repram/internal/logging"
	"repram/internal/node"
	"repram/internal/storage"
)

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

	// DNS-based bootstrap for public network
	if network == "public" && len(bootstrapNodes) == 0 {
		resolved := resolveBootstrapDNS("bootstrap.repram.network", 9090)
		bootstrapNodes = append(bootstrapNodes, resolved...)
	}

	clusterNode := cluster.NewClusterNode(nodeID, address, gossipPort, httpPort, replicationFactor, int64(maxStorageMB)*1024*1024, time.Duration(writeTimeout)*time.Second, clusterSecret)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := clusterNode.Start(ctx, bootstrapNodes); err != nil {
		log.Fatalf("Failed to start cluster node: %v", err)
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
	)
	server.securityMW = securityMW

	peerCount := len(bootstrapNodes)
	logging.Info("REPRAM node online. Peers: %d. Network: %s", peerCount, network)
	logging.Info("  Node ID: %s", nodeID)
	logging.Info("  HTTP: :%d  Gossip: :%d", httpPort, gossipPort)
	logging.Info("  Replication: %d  TTL range: %d-%ds  Write timeout: %ds", replicationFactor, minTTL, maxTTL, writeTimeout)
	if clusterSecret != "" {
		logging.Info("  Gossip authentication: HMAC-SHA256 (cluster secret configured)")
	} else {
		logging.Info("  Gossip authentication: none (open mode)")
	}

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		logging.Info("Shutting down...")
		securityMW.Close()
		clusterNode.Stop()
		cancel()
		os.Exit(0)
	}()

	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", httpPort), server.Router()))
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

// resolveBootstrapDNS resolves bootstrap peers via DNS.
// Returns host:port strings for each resolved address.
func resolveBootstrapDNS(hostname string, defaultPort int) []string {
	// Try SRV records first for port flexibility
	_, srvRecords, err := net.LookupSRV("gossip", "tcp", hostname)
	if err == nil && len(srvRecords) > 0 {
		var peers []string
		for _, srv := range srvRecords {
			peers = append(peers, fmt.Sprintf("%s:%d", strings.TrimSuffix(srv.Target, "."), srv.Port))
		}
		logging.Info("Resolved %d bootstrap peers via SRV", len(peers))
		return peers
	}

	// Fall back to A/AAAA records
	addrs, err := net.LookupHost(hostname)
	if err != nil {
		logging.Warn("DNS bootstrap resolution failed for %s: %v (starting as first node)", hostname, err)
		return nil
	}

	var peers []string
	for _, addr := range addrs {
		peers = append(peers, fmt.Sprintf("%s:%d", addr, defaultPort))
	}
	logging.Info("Resolved %d bootstrap peers via DNS", len(peers))
	return peers
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
	r.Use(node.TimeoutMiddleware(30 * time.Second))

	// v1 API endpoints
	r.HandleFunc("/v1/data/{key}", s.putHandler).Methods("PUT", "OPTIONS")
	r.HandleFunc("/v1/data/{key}", s.getHandler).Methods("GET", "HEAD", "OPTIONS")
	r.HandleFunc("/v1/keys", s.keysHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/health", s.healthHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/status", s.statusHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/v1/metrics", promhttp.Handler().ServeHTTP).Methods("GET", "OPTIONS")

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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"keys": keys,
	})
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
		gossipMsg.NodeInfo = &gossip.Node{
			ID:       gossip.NodeID(simpleMsg.NodeInfo.ID),
			Address:  simpleMsg.NodeInfo.Address,
			Port:     simpleMsg.NodeInfo.Port,
			HTTPPort: simpleMsg.NodeInfo.HTTPPort,
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
