package gossip

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"repram/internal/logging"
)

// BootstrapRequest is sent when a node wants to join the cluster
type BootstrapRequest struct {
	NodeID      string `json:"node_id"`
	Address     string `json:"address"`
	GossipPort  int    `json:"gossip_port"`
	HTTPPort    int    `json:"http_port"`
}

// BootstrapResponse contains the current cluster topology
type BootstrapResponse struct {
	Success bool    `json:"success"`
	Peers   []*Node `json:"peers"`
}

// Bootstrap connects to seed nodes and retrieves the cluster topology
func (p *Protocol) Bootstrap(ctx context.Context, seedNodes []string) error {
	logging.Info("[%s] Starting bootstrap process with %d seed nodes", p.localNode.ID, len(seedNodes))

	req := &BootstrapRequest{
		NodeID:     string(p.localNode.ID),
		Address:    p.localNode.Address,
		GossipPort: p.localNode.Port,
		HTTPPort:   p.localNode.HTTPPort,
	}

	// Try each seed node until we get a successful response
	for _, seed := range seedNodes {
		logging.Debug("[%s] Attempting to bootstrap from %s", p.localNode.ID, seed)

		peers, err := p.sendBootstrapRequest(ctx, seed, req)
		if err != nil {
			logging.Warn("[%s] Failed to bootstrap from %s: %v", p.localNode.ID, seed, err)
			continue
		}

		// Add all discovered peers
		for _, peer := range peers {
			if peer.ID != p.localNode.ID {
				p.addPeer(peer)
				logging.Info("[%s] Discovered peer %s via bootstrap", p.localNode.ID, peer.ID)
			}
		}

		logging.Info("[%s] Bootstrap successful, discovered %d peers", p.localNode.ID, len(peers))
		return nil
	}

	// If no seed nodes responded, we might be the first node
	logging.Info("[%s] No seed nodes available, starting as first node", p.localNode.ID)
	return nil
}

func (p *Protocol) sendBootstrapRequest(ctx context.Context, seedAddr string, req *BootstrapRequest) ([]*Node, error) {
	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	url := fmt.Sprintf("http://%s/v1/bootstrap", seedAddr)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if p.clusterSecret != "" {
		httpReq.Header.Set("X-Repram-Signature", SignBody(p.clusterSecret, jsonData))
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bootstrap rejected with status: %d", resp.StatusCode)
	}

	var bootstrapResp BootstrapResponse
	if err := json.NewDecoder(resp.Body).Decode(&bootstrapResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if !bootstrapResp.Success {
		return nil, fmt.Errorf("bootstrap failed")
	}

	return bootstrapResp.Peers, nil
}

// HandleBootstrap processes incoming bootstrap requests
func (p *Protocol) HandleBootstrap(req *BootstrapRequest) *BootstrapResponse {
	// Create node info from request
	newNode := &Node{
		ID:       NodeID(req.NodeID),
		Address:  req.Address,
		Port:     req.GossipPort,
		HTTPPort: req.HTTPPort,
	}

	// Add the new node as a peer
	p.addPeer(newNode)
	logging.Info("[%s] Node %s joined via bootstrap", p.localNode.ID, req.NodeID)

	// Notify all existing peers about the new node
	// This ensures all nodes know about each other
	go p.notifyPeersAboutNewNode(newNode)

	// Return current cluster topology
	peers := p.getPeers()
	// Include ourselves in the response
	allPeers := append(peers, p.localNode)

	return &BootstrapResponse{
		Success: true,
		Peers:   allPeers,
	}
}

// notifyPeersAboutNewNode sends a SYNC message to existing peers about a new node
func (p *Protocol) notifyPeersAboutNewNode(newNode *Node) {
	peers := p.getPeers()
	for _, peer := range peers {
		if peer.ID != newNode.ID {
			// Create a SYNC message with the new node info
			msg := &Message{
				Type:      MessageTypeSync,
				From:      p.localNode.ID,
				Timestamp: time.Now(),
				MessageID: generateMessageID(),
				NodeInfo:  newNode,
			}

			// Retry SYNC messages with exponential backoff
			go p.sendSyncWithRetry(peer, msg, newNode.ID, 3)
		}
	}
}

// sendSyncWithRetry attempts to send a SYNC message with exponential backoff retry
func (p *Protocol) sendSyncWithRetry(peer *Node, msg *Message, newNodeID NodeID, maxRetries int) {
	for attempt := 0; attempt < maxRetries; attempt++ {
		if err := p.Send(context.Background(), peer, msg); err != nil {
			if attempt == maxRetries-1 {
				logging.Error("[%s] Failed to notify %s about new node %s after %d attempts: %v",
					p.localNode.ID, peer.ID, newNodeID, maxRetries, err)
			} else {
				// Exponential backoff: 1s, 2s, 4s
				delay := time.Duration(1<<attempt) * time.Second
				logging.Warn("[%s] Failed to notify %s about new node %s (attempt %d/%d), retrying in %v: %v",
					p.localNode.ID, peer.ID, newNodeID, attempt+1, maxRetries, delay, err)
				time.Sleep(delay)
			}
		} else {
			logging.Debug("[%s] Notified %s about new node %s (attempt %d)",
				p.localNode.ID, peer.ID, newNodeID, attempt+1)
			return
		}
	}
}
