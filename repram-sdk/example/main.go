package main

import (
	"fmt"
	"log"
	"time"

	"repram-sdk/client"
	"repram-sdk/crypto"
)

func main() {
	key, err := crypto.GenerateKey()
	if err != nil {
		log.Fatal("Failed to generate key:", err)
	}

	client := client.NewClient("http://localhost:8080")

	testData := []byte("Hello, REPRAM SDK!")
	testKey := "sdk-test-key-123"
	ttl := 60 * time.Second

	fmt.Println("Storing encrypted data via SDK...")
	if err := client.Put(testKey, testData, ttl, key); err != nil {
		log.Fatal("Failed to store data:", err)
	}
	fmt.Println("Encrypted data stored successfully!")

	fmt.Println("Retrieving and decrypting data...")
	retrieved, err := client.Get(testKey, key)
	if err != nil {
		log.Fatal("Failed to retrieve data:", err)
	}

	fmt.Printf("Retrieved: %s\n", string(retrieved))
	
	if string(retrieved) == string(testData) {
		fmt.Println("Success! SDK encryption/decryption works perfectly.")
	} else {
		fmt.Println("Error: Data doesn't match!")
	}
}