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
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"repram/internal/cluster"
	"repram/internal/discovery"
	"repram/internal/gossip"
)

func main() {
	// Try both REPRAM_NODE_ID and NODE_ID for backwards compatibility
	nodeID := os.Getenv("REPRAM_NODE_ID")
	if nodeID == "" {
		nodeID = os.Getenv("NODE_ID")
	}
	if nodeID == "" {
		// Generate a unique node ID if not provided
		nodeID = fmt.Sprintf("node-%d", time.Now().UnixNano())
	}
	
	address := os.Getenv("NODE_ADDRESS")
	if address == "" {
		address = "localhost"
	}
	
	// Check if we should use auto-discovery
	useAutoDiscovery := os.Getenv("USE_AUTO_DISCOVERY") == "true"
	
	var httpPort, gossipPort int
	var bootstrapNodes []string
	
	if useAutoDiscovery {
		// Use port auto-discovery
		log.Printf("Starting auto-discovery for node %s", nodeID)
		allocator := discovery.NewPortAllocator(nodeID)
		
		// Allocate ports
		allocatedHTTP, allocatedGossip, err := allocator.AllocatePort()
		if err != nil {
			log.Fatalf("Failed to allocate port: %v", err)
		}
		
		httpPort = allocatedHTTP
		gossipPort = allocatedGossip
		
		// Clean up the temporary claim server
		allocator.Cleanup()
		
		// Discover peers
		peers := allocator.DiscoverPeers()
		bootstrapNodes = peers
		
		// Set up graceful shutdown
		defer allocator.NotifyShutdown()
		
		// Store allocator for use in HTTP handlers
		httpServer := &HTTPServer{allocator: allocator}
		defer func() {
			httpServer.allocator = nil
		}()
	} else {
		// Use traditional configuration
		
		// Use REPRAM_GOSSIP_PORT or fallback to NODE_PORT
		portStr := os.Getenv("REPRAM_GOSSIP_PORT")
		if portStr == "" {
			portStr = os.Getenv("NODE_PORT")
		}
		gossipPort = 9090
		if portStr != "" {
			if p, err := strconv.Atoi(portStr); err == nil {
				gossipPort = p
			}
		}
		
		// Use REPRAM_PORT or HTTP_PORT
		httpPortStr := os.Getenv("REPRAM_PORT")
		if httpPortStr == "" {
			httpPortStr = os.Getenv("HTTP_PORT")
		}
		httpPort = 8080
		if httpPortStr != "" {
			if p, err := strconv.Atoi(httpPortStr); err == nil {
				httpPort = p
			}
		}
		
		// Use REPRAM_BOOTSTRAP_PEERS or BOOTSTRAP_NODES
		bootstrapStr := os.Getenv("REPRAM_BOOTSTRAP_PEERS")
		if bootstrapStr == "" {
			bootstrapStr = os.Getenv("BOOTSTRAP_NODES")
		}
		if bootstrapStr != "" {
			bootstrapNodes = strings.Split(bootstrapStr, ",")
			// Clean up any whitespace
			for i, node := range bootstrapNodes {
				bootstrapNodes[i] = strings.TrimSpace(node)
			}
		}
	}
	
	replicationFactorStr := os.Getenv("REPLICATION_FACTOR")
	replicationFactor := 3
	if replicationFactorStr != "" {
		if rf, err := strconv.Atoi(replicationFactorStr); err == nil {
			replicationFactor = rf
		}
	}
	
	clusterNode := cluster.NewClusterNode(nodeID, address, gossipPort, httpPort, replicationFactor)
	
	ctx := context.Background()
	if err := clusterNode.Start(ctx, bootstrapNodes); err != nil {
		log.Fatalf("Failed to start cluster node: %v", err)
	}
	
	var allocator *discovery.PortAllocator
	if useAutoDiscovery {
		allocator = discovery.NewPortAllocator(nodeID)
		// Re-populate the active peers list
		allocator.DiscoverPeers()
	}
	
	server := &HTTPServer{
		clusterNode: clusterNode,
		allocator:   allocator,
		nodeID:      nodeID,
	}
	
	fmt.Printf("REPRAM cluster node %s starting:\n", nodeID)
	fmt.Printf("  Gossip address: %s:%d\n", address, gossipPort)
	fmt.Printf("  HTTP address: :%d\n", httpPort)
	fmt.Printf("  Replication factor: %d\n", replicationFactor)
	fmt.Printf("  Bootstrap nodes: %v\n", bootstrapNodes)
	if useAutoDiscovery {
		fmt.Printf("  Auto-discovery: enabled\n")
	}
	
	// Set up graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	
	go func() {
		<-sigChan
		log.Println("Received shutdown signal")
		if allocator != nil {
			allocator.NotifyShutdown()
		}
		os.Exit(0)
	}()
	
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", httpPort), server.Router()))
}

// CORS middleware for handling cross-origin requests
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("CORS middleware called for %s %s with origin: %s", r.Method, r.URL.Path, r.Header.Get("Origin"))
		
		// Allow specific origins
		origin := r.Header.Get("Origin")
		if origin == "https://fade.repram.io" || origin == "https://repram.io" || 
		   strings.HasPrefix(origin, "http://localhost") ||
		   strings.Contains(origin, "192.168.") || strings.Contains(origin, "10.") || 
		   strings.Contains(origin, "172.") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			log.Printf("Set CORS origin header to: %s", origin)
		}
		
		// Set other CORS headers
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, X-TTL")
		w.Header().Set("Access-Control-Max-Age", "3600")
		
		// Handle preflight requests
		if r.Method == "OPTIONS" {
			log.Printf("Handling OPTIONS preflight request")
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

type HTTPServer struct {
	clusterNode *cluster.ClusterNode
	allocator   *discovery.PortAllocator
	nodeID      string
}


func (s *HTTPServer) Router() *mux.Router {
	r := mux.NewRouter()
	
	// Add CORS middleware
	r.Use(corsMiddleware)
	
	r.HandleFunc("/health", s.healthHandler).Methods("GET", "OPTIONS")
	// Standard endpoints (compatible with load tester)
	r.HandleFunc("/data/{key}", s.putHandler).Methods("PUT", "OPTIONS")
	r.HandleFunc("/data/{key}", s.getHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/scan", s.scanHandler).Methods("GET", "OPTIONS")
	// Cluster-specific endpoints
	r.HandleFunc("/cluster/put/{key}", s.putHandler).Methods("PUT", "OPTIONS")
	r.HandleFunc("/cluster/get/{key}", s.getHandler).Methods("GET", "OPTIONS")
	r.HandleFunc("/cluster/scan", s.scanHandler).Methods("GET", "OPTIONS")
	// Gossip endpoint
	r.HandleFunc("/gossip/message", s.gossipHandler).Methods("POST", "OPTIONS")
	// Bootstrap endpoint
	r.HandleFunc("/bootstrap", s.bootstrapHandler).Methods("POST", "OPTIONS")
	
	// Discovery endpoints (only if auto-discovery is enabled)
	if s.allocator != nil {
		r.HandleFunc("/peer_announce", s.peerAnnounceHandler).Methods("POST", "OPTIONS")
		r.HandleFunc("/peer_leaving", s.peerLeavingHandler).Methods("POST", "OPTIONS")
		r.HandleFunc("/peers", s.peersHandler).Methods("GET", "OPTIONS")
	}
	
	return r
}

func (s *HTTPServer) healthHandler(w http.ResponseWriter, r *http.Request) {
	response := map[string]interface{}{
		"status": "healthy",
		"node_id": s.nodeID,
	}
	
	if s.allocator != nil {
		response["discovery_enabled"] = true
		response["active_peers"] = len(s.allocator.GetActivePeers())
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

func (s *HTTPServer) peerAnnounceHandler(w http.ResponseWriter, r *http.Request) {
	if s.allocator == nil {
		http.Error(w, "Auto-discovery not enabled", http.StatusNotImplemented)
		return
	}
	
	var announcement discovery.PeerAnnouncement
	if err := json.NewDecoder(r.Body).Decode(&announcement); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	
	// Add the new peer to our list
	s.allocator.AddPeer(announcement.HTTPPort)
	
	// TODO: Also inform the cluster node about the new peer for gossip
	// This would require extending the cluster node API
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"acknowledged": true})
}

func (s *HTTPServer) peerLeavingHandler(w http.ResponseWriter, r *http.Request) {
	if s.allocator == nil {
		http.Error(w, "Auto-discovery not enabled", http.StatusNotImplemented)
		return
	}
	
	var departure discovery.PeerDeparture
	if err := json.NewDecoder(r.Body).Decode(&departure); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	
	// Remove the peer from our list
	s.allocator.RemovePeer(departure.HTTPPort)
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"acknowledged": true})
}

func (s *HTTPServer) peersHandler(w http.ResponseWriter, r *http.Request) {
	if s.allocator == nil {
		http.Error(w, "Auto-discovery not enabled", http.StatusNotImplemented)
		return
	}
	
	peers := s.allocator.GetActivePeers()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"peers": peers,
		"last_updated": time.Now(),
	})
}

func (s *HTTPServer) putHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	
	// Read raw body data - no encoding assumptions
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	
	// Get TTL from query parameter or header
	ttl := 60 // Default 60 seconds
	if ttlStr := r.URL.Query().Get("ttl"); ttlStr != "" {
		if parsedTTL, err := strconv.Atoi(ttlStr); err == nil && parsedTTL > 0 {
			ttl = parsedTTL
		}
	} else if ttlHeader := r.Header.Get("X-TTL"); ttlHeader != "" {
		if parsedTTL, err := strconv.Atoi(ttlHeader); err == nil && parsedTTL > 0 {
			ttl = parsedTTL
		}
	}
	
	// Enforce minimum TTL per core principles (5 minutes for network propagation)
	if ttl < 300 {
		ttl = 300
	}
	
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.clusterNode.Put(ctx, key, body, time.Duration(ttl)*time.Second); err != nil {
		http.Error(w, fmt.Sprintf("Write failed: %v", err), http.StatusInternalServerError)
		return
	}
	
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "OK")
}

func (s *HTTPServer) getHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	
	data, exists := s.clusterNode.Get(key)
	if !exists {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

func (s *HTTPServer) scanHandler(w http.ResponseWriter, r *http.Request) {
	// Get all keys from the cluster node
	keys := s.clusterNode.Scan()
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"keys": keys,
	})
}

func (s *HTTPServer) gossipHandler(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	
	var simpleMsg gossip.SimpleMessage
	if err := json.Unmarshal(body, &simpleMsg); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	
	// Convert SimpleMessage to gossip.Message
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
	
	// Convert NodeInfo if present
	if simpleMsg.NodeInfo != nil {
		gossipMsg.NodeInfo = &gossip.Node{
			ID:       gossip.NodeID(simpleMsg.NodeInfo.ID),
			Address:  simpleMsg.NodeInfo.Address,
			Port:     simpleMsg.NodeInfo.Port,
			HTTPPort: simpleMsg.NodeInfo.HTTPPort,
		}
	}
	
	// Handle the gossip message
	if err := s.clusterNode.HandleGossipMessage(gossipMsg); err != nil {
		http.Error(w, fmt.Sprintf("Failed to handle gossip message: %v", err), http.StatusInternalServerError)
		return
	}
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
	})
}

func (s *HTTPServer) bootstrapHandler(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	
	var req gossip.BootstrapRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	
	resp := s.clusterNode.HandleBootstrap(&req)
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}