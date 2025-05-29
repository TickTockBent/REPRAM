package main

import (
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

	"repram/internal/node"
	"repram/internal/storage"
)

type RawPutRequest struct {
	Key  string `json:"key"`  // Optional: if provided, use this key
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	store := storage.NewMemoryStore()
	nodeServer := node.NewServer(store)

	router := nodeServer.Router()
	
	router.HandleFunc("/raw/put", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Failed to read body", http.StatusBadRequest)
			return
		}

		var req RawPutRequest
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		// Use provided key or generate one
		key := req.Key
		if key == "" {
			key = fmt.Sprintf("raw-%d", time.Now().UnixNano())
		}
		ttl := time.Duration(req.TTL) * time.Second
		
		if err := store.Put(key, []byte(req.Data), ttl); err != nil {
			http.Error(w, "Storage failed", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"key": key})
	}).Methods("POST")

	router.HandleFunc("/raw/get/{key}", func(w http.ResponseWriter, r *http.Request) {
		vars := mux.Vars(r)
		key := vars["key"]
		
		// Get the data first
		data, exists := store.Get(key)
		if !exists {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		
		// Get TTL by using the Range method
		remainingTTL := 0
		store.Range(func(k string, ttl int) bool {
			if k == key {
				remainingTTL = ttl
				return false // Stop iterating
			}
			return true
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"data": string(data),
			"ttl": remainingTTL,
		})
	}).Methods("GET")
	
	router.HandleFunc("/raw/scan", func(w http.ResponseWriter, r *http.Request) {
		prefix := r.URL.Query().Get("prefix")
		limitStr := r.URL.Query().Get("limit")
		limit := 100 // default
		
		if limitStr != "" {
			if parsedLimit, err := strconv.Atoi(limitStr); err == nil && parsedLimit > 0 {
				if parsedLimit > 1000 {
					limit = 1000 // max limit
				} else {
					limit = parsedLimit
				}
			}
		}
		
		type KeyInfo struct {
			Key  string `json:"key"`
			TTL  int    `json:"ttl"`
		}
		
		var results []KeyInfo
		
		// Get all keys from the memory store
		// store is already *storage.MemoryStore, no need for type assertion
		store.Range(func(key string, ttl int) bool {
			if prefix == "" || strings.HasPrefix(key, prefix) {
				results = append(results, KeyInfo{
					Key: key,
					TTL: ttl,
				})
				return len(results) < limit
			}
			return true
		})
		
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"keys": results,
		})
	}).Methods("GET")
	
	fmt.Printf("REPRAM open-source node starting on port %s\n", port)
	fmt.Println("Endpoints:")
	fmt.Println("  POST /raw/put - Store unencrypted data")
	fmt.Println("  GET /raw/get/{key} - Retrieve unencrypted data")
	fmt.Println("  GET /raw/scan - List keys with optional prefix filter")
	fmt.Println("  PUT /data/{key} - Store binary data (for SDK use)")
	fmt.Println("  GET /data/{key} - Retrieve binary data (for SDK use)")
	log.Fatal(http.ListenAndServe(":"+port, router))
}