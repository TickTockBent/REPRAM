package main

import (
	"context"
	"fmt"
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
	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = "node-1"
	}
	
	address := os.Getenv("NODE_ADDRESS")
	if address == "" {
		address = "localhost"
	}
	
	portStr := os.Getenv("NODE_PORT")
	port := 8090
	if portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil {
			port = p
		}
	}
	
	httpPortStr := os.Getenv("HTTP_PORT")
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
	
	bootstrapStr := os.Getenv("BOOTSTRAP_NODES")
	var bootstrapNodes []string
	if bootstrapStr != "" {
		bootstrapNodes = strings.Split(bootstrapStr, ",")
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

func (s *HTTPServer) Router() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/health", s.healthHandler).Methods("GET")
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
	
	data := make([]byte, r.ContentLength)
	if _, err := r.Body.Read(data); err != nil && err.Error() != "EOF" {
		http.Error(w, "Failed to read data", http.StatusBadRequest)
		return
	}
	
	ttlStr := r.Header.Get("X-TTL")
	ttl := 60 // Default 60 seconds
	if ttlStr != "" {
		if t, err := strconv.Atoi(ttlStr); err == nil {
			ttl = t
		}
	}
	
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.clusterNode.Put(ctx, key, data, time.Duration(ttl)*time.Second); err != nil {
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