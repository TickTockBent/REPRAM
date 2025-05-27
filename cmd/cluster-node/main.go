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
	
	clusterNode := cluster.NewClusterNode(nodeID, address, port, replicationFactor)
	
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