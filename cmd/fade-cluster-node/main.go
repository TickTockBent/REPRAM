package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"repram/internal/cluster"
	"repram/internal/gossip"
)

func main() {
	nodeID := os.Getenv("REPRAM_NODE_ID")
	if nodeID == "" {
		nodeID = os.Getenv("NODE_ID")
	}
	if nodeID == "" {
		nodeID = "fade-node-1"
	}
	
	address := os.Getenv("NODE_ADDRESS")
	if address == "" {
		address = "localhost"
	}
	
	portStr := os.Getenv("REPRAM_GOSSIP_PORT")
	if portStr == "" {
		portStr = os.Getenv("NODE_PORT")
	}
	port := 9090
	if portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil {
			port = p
		}
	}
	
	httpPortStr := os.Getenv("REPRAM_PORT")
	if httpPortStr == "" {
		httpPortStr = os.Getenv("HTTP_PORT")
	}
	httpPort := 8080
	if httpPortStr != "" {
		if p, err := strconv.Atoi(httpPortStr); err == nil {
			httpPort = p
		}
	}
	
	replicationFactorStr := os.Getenv("REPLICATION_FACTOR")
	replicationFactor := 3
	if replicationFactorStr != "" {
		if rf, err := strconv.Atoi(replicationFactorStr); err == nil {
			replicationFactor = rf
		}
	}
	
	bootstrapStr := os.Getenv("REPRAM_BOOTSTRAP_PEERS")
	if bootstrapStr == "" {
		bootstrapStr = os.Getenv("BOOTSTRAP_NODES")
	}
	var bootstrapNodes []string
	if bootstrapStr != "" {
		bootstrapNodes = strings.Split(bootstrapStr, ",")
		for i, node := range bootstrapNodes {
			bootstrapNodes[i] = strings.TrimSpace(node)
		}
	}
	
	clusterNode := cluster.NewClusterNode(nodeID, address, port, replicationFactor)
	
	ctx := context.Background()
	if err := clusterNode.Start(ctx, bootstrapNodes); err != nil {
		log.Fatalf("Failed to start cluster node: %v", err)
	}
	
	server := &HTTPServer{clusterNode: clusterNode}
	
	fmt.Printf("REPRAM Fade cluster node %s starting:\n", nodeID)
	fmt.Printf("  Gossip address: %s:%d\n", address, port)
	fmt.Printf("  HTTP address: :%d\n", httpPort)
	fmt.Printf("  Replication factor: %d\n", replicationFactor)
	fmt.Printf("  Bootstrap nodes: %v\n", bootstrapNodes)
	fmt.Printf("  API endpoints: /data/{key} (encrypted), /raw/* (unencrypted demo)\n")
	
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", httpPort), server.Router()))
}

type HTTPServer struct {
	clusterNode *cluster.ClusterNode
}

type PutRequest struct {
	Data []byte `json:"data"`
	TTL  int    `json:"ttl"`
}

type RawPutRequest struct {
	Key  string `json:"key,omitempty"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

func (s *HTTPServer) Router() *mux.Router {
	r := mux.NewRouter()
	
	// Health endpoint
	r.HandleFunc("/health", s.healthHandler).Methods("GET")
	
	// Standard encrypted endpoints (for production SDK)
	r.HandleFunc("/data/{key}", s.putHandler).Methods("PUT")
	r.HandleFunc("/data/{key}", s.getHandler).Methods("GET")
	
	// Raw endpoints (for demos like Fade) - unencrypted data
	r.HandleFunc("/raw/put", s.rawPutHandler).Methods("POST")
	r.HandleFunc("/raw/get/{key}", s.rawGetHandler).Methods("GET")
	r.HandleFunc("/raw/scan", s.rawScanHandler).Methods("GET")
	
	// Gossip protocol endpoint
	r.HandleFunc("/gossip/message", s.gossipMessageHandler).Methods("POST")
	
	// Enable CORS for all endpoints
	r.Use(corsMiddleware)
	
	return r
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

func (s *HTTPServer) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK")
}

// Standard encrypted endpoint for production use
func (s *HTTPServer) putHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	
	var req PutRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	
	if req.TTL <= 0 {
		req.TTL = 60
	}
	
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.clusterNode.Put(ctx, key, req.Data, time.Duration(req.TTL)*time.Second); err != nil {
		http.Error(w, fmt.Sprintf("Write failed: %v", err), http.StatusInternalServerError)
		return
	}
	
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "OK")
}

// Standard encrypted endpoint for production use
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

// Raw endpoint for demos - stores unencrypted strings
func (s *HTTPServer) rawPutHandler(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	
	var req RawPutRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	
	if req.TTL <= 0 {
		req.TTL = 300 // 5 minute minimum per core principles
	}
	
	// Generate key if not provided (for Fade compatibility)
	key := req.Key
	if key == "" {
		key = fmt.Sprintf("msg_%d", time.Now().UnixNano())
	}
	
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	
	// Store the raw string data (converted to bytes)
	if err := s.clusterNode.Put(ctx, key, []byte(req.Data), time.Duration(req.TTL)*time.Second); err != nil {
		http.Error(w, fmt.Sprintf("Write failed: %v", err), http.StatusInternalServerError)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"key": key})
}

// Raw endpoint for demos - retrieves unencrypted strings
func (s *HTTPServer) rawGetHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	
	data, exists := s.clusterNode.Get(key)
	if !exists {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	
	// For raw endpoint, we return JSON with data and TTL
	// Note: We can't get exact TTL from cluster node interface, so we return 0
	// This maintains API compatibility with the raw node
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"data": string(data),
		"ttl":  0, // TTL not available in cluster interface
	})
}

// Raw scan endpoint for demos - lists all keys
func (s *HTTPServer) rawScanHandler(w http.ResponseWriter, r *http.Request) {
	// Note: This would require extending the cluster interface to support scanning
	// For now, return empty list to maintain API compatibility
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"keys": []string{},
		"count": 0,
	})
}

// gossipMessageHandler handles incoming gossip protocol messages
func (s *HTTPServer) gossipMessageHandler(w http.ResponseWriter, r *http.Request) {
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
	
	// Convert SimpleMessage to Message and process
	msg := &gossip.Message{
		Type:      gossip.MessageType(simpleMsg.Type),
		From:      gossip.NodeID(simpleMsg.From),
		To:        gossip.NodeID(simpleMsg.To),
		Key:       simpleMsg.Key,
		Data:      simpleMsg.Data,
		TTL:       int(simpleMsg.TTL),
		Timestamp: time.Unix(simpleMsg.Timestamp, 0),
		MessageID: simpleMsg.MessageID,
	}
	
	// Handle the message via cluster node
	if err := s.clusterNode.HandleGossipMessage(msg); err != nil {
		http.Error(w, fmt.Sprintf("Message processing failed: %v", err), http.StatusInternalServerError)
		return
	}
	
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "Message processed")
}