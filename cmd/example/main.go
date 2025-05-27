package main

import (
	"fmt"
	"log"
	"time"

	"repram/internal/crypto"
	"repram/pkg/client"
)

func main() {
	key, err := crypto.GenerateKey()
	if err != nil {
		log.Fatal("Failed to generate key:", err)
	}

	client := client.NewClient("http://localhost:8080")

	testData := []byte("Hello, REPRAM!")
	testKey := "test-key-123"
	ttl := 60 * time.Second

	fmt.Println("Storing data...")
	if err := client.Put(testKey, testData, ttl, key); err != nil {
		log.Fatal("Failed to store data:", err)
	}
	fmt.Println("Data stored successfully!")

	fmt.Println("Retrieving data...")
	retrieved, err := client.Get(testKey, key)
	if err != nil {
		log.Fatal("Failed to retrieve data:", err)
	}

	fmt.Printf("Retrieved: %s\n", string(retrieved))
	
	if string(retrieved) == string(testData) {
		fmt.Println("Success! Data matches original.")
	} else {
		fmt.Println("Error: Data doesn't match!")
	}
}