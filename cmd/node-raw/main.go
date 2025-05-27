package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/mux"

	"repram/internal/node"
	"repram/internal/storage"
)

type RawPutRequest struct {
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

		key := fmt.Sprintf("raw-%d", time.Now().UnixNano())
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
		data, exists := store.Get(key)
		if !exists {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"data": string(data)})
	}).Methods("GET")
	
	fmt.Printf("REPRAM open-source node starting on port %s\n", port)
	fmt.Println("Endpoints:")
	fmt.Println("  POST /raw/put - Store unencrypted data")
	fmt.Println("  GET /raw/get/{key} - Retrieve unencrypted data")
	fmt.Println("  PUT /data/{key} - Store binary data (for SDK use)")
	fmt.Println("  GET /data/{key} - Retrieve binary data (for SDK use)")
	log.Fatal(http.ListenAndServe(":"+port, router))
}