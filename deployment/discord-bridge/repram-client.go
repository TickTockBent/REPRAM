package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// RepramClient handles communication with REPRAM nodes
type RepramClient struct {
	nodes   []string
	client  *http.Client
	current int // Round-robin current node index
}

// RepramMessage represents a message stored in REPRAM
type RepramMessage struct {
	Key       string    `json:"key"`
	Content   string    `json:"content"`
	Author    string    `json:"author"`
	Timestamp time.Time `json:"timestamp"`
	TTL       int       `json:"ttl"`
	Source    string    `json:"source"` // "discord" or "fade"
}

// NewRepramClient creates a new REPRAM client
func NewRepramClient(nodes []string) *RepramClient {
	return &RepramClient{
		nodes: nodes,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		current: 0,
	}
}

// StoreMessage stores a message in REPRAM and returns the generated key
func (rc *RepramClient) StoreMessage(msg *RepramMessage) (string, error) {
	// Generate a unique key for the message
	key := rc.generateKey(msg)
	msg.Key = key

	// Format message content (similar to FADE format)
	content := fmt.Sprintf("%s|%s|%s|%d|%s",
		msg.Content,
		msg.Author,
		msg.Timestamp.Format(time.RFC3339),
		msg.TTL,
		msg.Source,
	)

	// Try each node until one succeeds
	for i := 0; i < len(rc.nodes); i++ {
		nodeURL := rc.getNextNode()
		err := rc.putData(nodeURL, key, content, msg.TTL)
		if err == nil {
			return key, nil
		}
		// Log error and try next node
		fmt.Printf("Failed to store in node %s: %v\n", nodeURL, err)
	}

	return "", fmt.Errorf("failed to store message in any REPRAM node")
}

// GetRecentMessages retrieves recent messages from REPRAM
func (rc *RepramClient) GetRecentMessages() ([]*RepramMessage, error) {
	// Get all keys from a node
	keys, err := rc.scanKeys()
	if err != nil {
		return nil, fmt.Errorf("failed to scan keys: %w", err)
	}

	var messages []*RepramMessage

	// Retrieve each message
	for _, key := range keys {
		msg, err := rc.getMessage(key)
		if err != nil {
			// Skip messages that can't be retrieved (might be expired)
			continue
		}
		messages = append(messages, msg)
	}

	return messages, nil
}

// getMessage retrieves a single message by key
func (rc *RepramClient) getMessage(key string) (*RepramMessage, error) {
	// Try each node until one succeeds
	for i := 0; i < len(rc.nodes); i++ {
		nodeURL := rc.getNextNode()
		content, err := rc.getData(nodeURL, key)
		if err == nil {
			return rc.parseMessage(key, content)
		}
	}

	return nil, fmt.Errorf("message not found or expired: %s", key)
}

// putData stores data in a REPRAM node
func (rc *RepramClient) putData(nodeURL, key, content string, ttl int) error {
	url := fmt.Sprintf("%s/data/%s?ttl=%d", nodeURL, key, ttl)

	req, err := http.NewRequest("PUT", url, strings.NewReader(content))
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", "text/plain")

	resp, err := rc.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	return nil
}

// getData retrieves data from a REPRAM node
func (rc *RepramClient) getData(nodeURL, key string) (string, error) {
	url := fmt.Sprintf("%s/data/%s", nodeURL, key)

	resp, err := rc.client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("not found")
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return string(body), nil
}

// scanKeys gets all available keys from REPRAM
func (rc *RepramClient) scanKeys() ([]string, error) {
	// Try each node until one succeeds
	for i := 0; i < len(rc.nodes); i++ {
		nodeURL := rc.getNextNode()
		keys, err := rc.scanKeysFromNode(nodeURL)
		if err == nil {
			return keys, nil
		}
	}

	return nil, fmt.Errorf("failed to scan keys from any node")
}

// scanKeysFromNode scans keys from a specific node
func (rc *RepramClient) scanKeysFromNode(nodeURL string) ([]string, error) {
	url := fmt.Sprintf("%s/scan", nodeURL)

	resp, err := rc.client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var result struct {
		Keys []string `json:"keys"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	return result.Keys, nil
}

// getNextNode returns the next node URL in round-robin fashion
func (rc *RepramClient) getNextNode() string {
	node := rc.nodes[rc.current]
	rc.current = (rc.current + 1) % len(rc.nodes)
	return node
}

// generateKey generates a unique key for a message
func (rc *RepramClient) generateKey(msg *RepramMessage) string {
	// Generate a key similar to FADE format: adjective-noun-timestamp
	adjectives := []string{
		"swift", "bright", "silent", "cosmic", "digital", "quantum", "cyber", "neon",
		"electric", "magnetic", "atomic", "neural", "virtual", "synthetic", "dynamic",
		"ethereal", "photonic", "crystalline", "metallic", "plasma",
	}

	nouns := []string{
		"message", "signal", "pulse", "wave", "beam", "data", "packet", "stream",
		"fragment", "echo", "cipher", "code", "link", "node", "core", "matrix",
		"grid", "network", "channel", "frequency",
	}

	timestamp := time.Now().Unix()
	adjective := adjectives[timestamp%int64(len(adjectives))]
	noun := nouns[(timestamp/10)%int64(len(nouns))]

	return fmt.Sprintf("discord-%s-%s-%d", adjective, noun, timestamp)
}

// parseMessage parses a message from REPRAM content
func (rc *RepramClient) parseMessage(key, content string) (*RepramMessage, error) {
	// Parse the pipe-separated format: content|author|timestamp|ttl|source
	parts := strings.SplitN(content, "|", 5)
	if len(parts) < 5 {
		// Check if this is a FADE message format: content|callsign|location
		return rc.parseFadeMessage(key, content, parts)
	}

	timestamp, err := time.Parse(time.RFC3339, parts[2])
	if err != nil {
		timestamp = time.Now()
	}

	var ttl int
	fmt.Sscanf(parts[3], "%d", &ttl)
	if ttl == 0 {
		ttl = 3600 // Default 1 hour
	}

	return &RepramMessage{
		Key:       key,
		Content:   parts[0],
		Author:    parts[1],
		Timestamp: timestamp,
		TTL:       ttl,
		Source:    parts[4],
	}, nil
}

// parseFadeMessage parses a FADE message format: content|callsign|location
func (rc *RepramClient) parseFadeMessage(key, content string, parts []string) (*RepramMessage, error) {
	var messageContent, callsign, location string
	
	if len(parts) == 1 {
		// Simple message with no callsign/location
		messageContent = parts[0]
	} else if len(parts) >= 2 {
		// Message with callsign and optionally location
		messageContent = parts[0]
		callsign = parts[1]
		if len(parts) >= 3 && parts[2] != "" {
			location = parts[2]
		}
	}
	
	// Build author string from callsign and location
	author := "unknown"
	if callsign != "" {
		if location != "" {
			author = fmt.Sprintf("%s (%s)", callsign, location)
		} else {
			author = callsign
		}
	}
	
	return &RepramMessage{
		Key:       key,
		Content:   messageContent,
		Author:    author,
		Timestamp: time.Now(),
		TTL:       3600, // Default TTL, will be updated from actual TTL
		Source:    "fade",
	}, nil
}