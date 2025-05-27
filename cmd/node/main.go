package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"repram/internal/node"
	"repram/internal/storage"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	store := storage.NewMemoryStore()
	nodeServer := node.NewServer(store)

	fmt.Printf("REPRAM node starting on port %s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nodeServer.Router()))
}