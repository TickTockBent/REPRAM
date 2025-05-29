package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// ProxyServer handles both static files and REPRAM API proxying
type ProxyServer struct {
	nodes       []string
	currentNode int
	fileDir     string
}

// enableCORS adds CORS headers to responses
func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// proxyRequest forwards requests to REPRAM nodes
func (ps *ProxyServer) proxyRequest(w http.ResponseWriter, r *http.Request, path string) {
	enableCORS(w)
	
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Try each node until one works
	var lastErr error
	for i := 0; i < len(ps.nodes); i++ {
		nodeIndex := (ps.currentNode + i) % len(ps.nodes)
		nodeURL := ps.nodes[nodeIndex] + path
		
		// Create new request
		var req *http.Request
		var err error
		
		if r.Body != nil {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body)) // Reset for potential retry
			req, err = http.NewRequest(r.Method, nodeURL, bytes.NewReader(body))
		} else {
			req, err = http.NewRequest(r.Method, nodeURL, nil)
		}
		
		if err != nil {
			lastErr = err
			continue
		}
		
		// Copy headers
		req.Header = r.Header.Clone()
		
		// Make request with timeout
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			ps.currentNode = (ps.currentNode + 1) % len(ps.nodes) // Try next node next time
			continue
		}
		defer resp.Body.Close()
		
		// Copy response headers
		for k, v := range resp.Header {
			w.Header()[k] = v
		}
		enableCORS(w) // Re-add CORS headers
		
		// Copy status code and body
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
	
	// All nodes failed
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]string{
		"error": fmt.Sprintf("All nodes unavailable: %v", lastErr),
	})
}

func (ps *ProxyServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Handle API routes
	if strings.HasPrefix(r.URL.Path, "/api/") {
		// Remove /api prefix and proxy to REPRAM node
		path := strings.TrimPrefix(r.URL.Path, "/api")
		ps.proxyRequest(w, r, path)
		return
	}
	
	// Serve static files
	filePath := filepath.Join(ps.fileDir, r.URL.Path)
	
	// Default to index.html for directory requests
	if strings.HasSuffix(r.URL.Path, "/") {
		filePath = filepath.Join(filePath, "index.html")
	}
	
	// Check if file exists
	if _, err := filepath.Abs(filePath); err == nil {
		http.ServeFile(w, r, filePath)
		return
	}
	
	// File not found
	http.NotFound(w, r)
}

func main() {
	// Command line flags
	port := flag.String("port", "3000", "Port to serve on")
	dir := flag.String("dir", "web", "Directory to serve files from")
	nodes := flag.String("nodes", "http://localhost:8080,http://localhost:8081,http://localhost:8082", "Comma-separated list of REPRAM node URLs")
	flag.Parse()

	// Get absolute path
	absDir, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatal(err)
	}

	// Parse node URLs
	nodeList := strings.Split(*nodes, ",")
	for i, node := range nodeList {
		nodeList[i] = strings.TrimSpace(node)
	}

	// Create proxy server
	proxy := &ProxyServer{
		nodes:       nodeList,
		currentNode: 0,
		fileDir:     absDir,
	}

	// Start server
	addr := fmt.Sprintf("0.0.0.0:%s", *port)
	log.Printf("Fade UI server starting on http://0.0.0.0:%s", *port)
	log.Printf("Server will be accessible from all network interfaces")
	log.Printf("Serving files from: %s", absDir)
	log.Printf("Proxying to REPRAM nodes: %v", nodeList)
	log.Printf("\nAPI endpoints will be proxied through /api/*")
	log.Printf("Example: /api/health -> %s/health", nodeList[0])
	
	if err := http.ListenAndServe(addr, proxy); err != nil {
		log.Fatal(err)
	}
}