package gossip

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// HTTPTransport implements gossip communication over HTTP
type HTTPTransport struct {
	localNode      *Node
	messageHandler func(*Message) error
	client         *http.Client
	mu             sync.RWMutex
}

// NewHTTPTransport creates a new HTTP-based transport
func NewHTTPTransport(localNode *Node) *HTTPTransport {
	return &HTTPTransport{
		localNode: localNode,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// Start initializes the transport (no-op for HTTP as we use the main HTTP server)
func (t *HTTPTransport) Start(ctx context.Context) error {
	fmt.Printf("[HTTPTransport] Started for node %s (HTTP port: %d)\n", t.localNode.ID, t.localNode.HTTPPort)
	return nil
}

// Stop shuts down the transport
func (t *HTTPTransport) Stop() error {
	return nil
}

// Send sends a message to a specific node via HTTP
func (t *HTTPTransport) Send(ctx context.Context, node *Node, msg *Message) error {
	// Convert to SimpleMessage for HTTP transport
	simpleMsg := &SimpleMessage{
		Type:      string(msg.Type),
		From:      string(msg.From),
		To:        string(msg.To),
		Key:       msg.Key,
		Data:      msg.Data,
		TTL:       int32(msg.TTL),
		Timestamp: msg.Timestamp.Unix(),
		MessageID: msg.MessageID,
	}
	
	// Include NodeInfo if present
	if msg.NodeInfo != nil {
		simpleMsg.NodeInfo = &SimpleNodeInfo{
			ID:       string(msg.NodeInfo.ID),
			Address:  msg.NodeInfo.Address,
			Port:     msg.NodeInfo.Port,
			HTTPPort: msg.NodeInfo.HTTPPort,
		}
	}
	
	// Send to the HTTP gossip endpoint
	url := fmt.Sprintf("http://%s:%d/gossip/message", node.Address, node.HTTPPort)
	
	jsonData, err := json.Marshal(simpleMsg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	
	resp, err := t.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send message to %s: %w", url, err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("message rejected by %s with status: %d", node.ID, resp.StatusCode)
	}
	
	fmt.Printf("[HTTPTransport] Successfully sent %s message to %s at %s\n", msg.Type, node.ID, url)
	return nil
}

// Broadcast sends a message to all nodes (handled by the Protocol layer)
func (t *HTTPTransport) Broadcast(ctx context.Context, msg *Message) error {
	// The Protocol layer handles the actual broadcasting to all peers
	return fmt.Errorf("broadcast should be handled by Protocol layer")
}

// SetMessageHandler sets the handler for incoming messages
func (t *HTTPTransport) SetMessageHandler(handler func(*Message) error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.messageHandler = handler
}