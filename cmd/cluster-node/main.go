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
	// Try both REPRAM_NODE_ID and NODE_ID for backwards compatibility
	nodeID := os.Getenv("REPRAM_NODE_ID")
	if nodeID == "" {
		nodeID = os.Getenv("NODE_ID")
	}
	if nodeID == "" {
		nodeID = "node-1"
	}
	
	address := os.Getenv("NODE_ADDRESS")
	if address == "" {
		address = "localhost"
	}
	
	// Use REPRAM_GOSSIP_PORT or fallback to NODE_PORT
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
	
	// Use REPRAM_PORT or HTTP_PORT
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
	
	// Use REPRAM_BOOTSTRAP_PEERS or BOOTSTRAP_NODES
	bootstrapStr := os.Getenv("REPRAM_BOOTSTRAP_PEERS")
	if bootstrapStr == "" {
		bootstrapStr = os.Getenv("BOOTSTRAP_NODES")
	}
	var bootstrapNodes []string
	if bootstrapStr != "" {
		bootstrapNodes = strings.Split(bootstrapStr, ",")
		// Clean up any whitespace
		for i, node := range bootstrapNodes {
			bootstrapNodes[i] = strings.TrimSpace(node)
		}
	}
	
	clusterNode := cluster.NewClusterNode(nodeID, address, port, httpPort, replicationFactor)
	
	ctx := context.Background()
	if err := clusterNode.Start(ctx, bootstrapNodes); err != nil {
		log.Fatalf("Failed to start cluster node: %v", err)
	}
	
	server := &HTTPServer{clusterNode: clusterNode}
	
	fmt.Printf("REPRAM cluster node %s starting:\n", nodeID)
	fmt.Printf("  Gossip address: %s:%d\n", address, port)
	fmt.Printf("  HTTP address: :%d\n", httpPort)
	fmt.Printf("  Replication factor: %d\n", replicationFactor)
	fmt.Printf("  Bootstrap nodes: %v\n", bootstrapNodes)
	
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", httpPort), server.Router()))
}

type HTTPServer struct {
	clusterNode *cluster.ClusterNode
}

type PutRequest struct {
	Data []byte `json:"data"`
	TTL  int    `json:"ttl"` // TTL in seconds
}

func (s *HTTPServer) Router() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/health", s.healthHandler).Methods("GET")
	// Standard endpoints (compatible with load tester)
	r.HandleFunc("/data/{key}", s.putHandler).Methods("PUT")
	r.HandleFunc("/data/{key}", s.getHandler).Methods("GET")
	// Cluster-specific endpoints
	r.HandleFunc("/cluster/put/{key}", s.putHandler).Methods("PUT")
	r.HandleFunc("/cluster/get/{key}", s.getHandler).Methods("GET")
	// Gossip endpoint
	r.HandleFunc("/gossip/message", s.gossipHandler).Methods("POST")
	// Bootstrap endpoint
	r.HandleFunc("/bootstrap", s.bootstrapHandler).Methods("POST")
	return r
}

func (s *HTTPServer) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK")
}

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
		req.TTL = 60 // Default 60 seconds
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