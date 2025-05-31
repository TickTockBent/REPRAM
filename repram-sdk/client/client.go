package client

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"time"

	"repram-sdk/crypto"
)

type Client struct {
	baseURL string
	httpClient *http.Client
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
	// Encrypt data before sending
	encryptedData, err := crypto.Encrypt(data, encryptionKey)
	if err != nil {
		return fmt.Errorf("encryption failed: %w", err)
	}
	
	// Send raw encrypted data as body
	url := fmt.Sprintf("%s/data/%s?ttl=%d", c.baseURL, key, int(ttl.Seconds()))
	httpReq, err := http.NewRequest("PUT", url, bytes.NewReader(encryptedData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	// Content-Type is application/octet-stream by default for raw binary data
	
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