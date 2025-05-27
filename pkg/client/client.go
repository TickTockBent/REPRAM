package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"repram/internal/crypto"
)

type Client struct {
	baseURL string
	httpClient *http.Client
}

type PutRequest struct {
	Data []byte `json:"data"`
	TTL  int    `json:"ttl"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) Put(key string, data []byte, ttl time.Duration, encryptionKey []byte) error {
	encryptedData, err := crypto.Encrypt(data, encryptionKey)
	if err != nil {
		return fmt.Errorf("encryption failed: %w", err)
	}
	
	req := PutRequest{
		Data: encryptedData,
		TTL:  int(ttl.Seconds()),
	}
	
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}
	
	url := fmt.Sprintf("%s/data/%s", c.baseURL, key)
	httpReq, err := http.NewRequest("PUT", url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server returned status %d: %s", resp.StatusCode, string(body))
	}
	
	return nil
}

func (c *Client) Get(key string, encryptionKey []byte) ([]byte, error) {
	url := fmt.Sprintf("%s/data/%s", c.baseURL, key)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("key not found or expired")
	}
	
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned status %d", resp.StatusCode)
	}
	
	encryptedData, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}
	
	plaintext, err := crypto.Decrypt(encryptedData, encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("decryption failed: %w", err)
	}
	
	return plaintext, nil
}