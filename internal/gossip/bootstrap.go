package gossip

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
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
	fmt.Printf("[%s] Starting bootstrap process with %d seed nodes\n", p.localNode.ID, len(seedNodes))
	
	req := &BootstrapRequest{
		NodeID:     string(p.localNode.ID),
		Address:    p.localNode.Address,
		GossipPort: p.localNode.Port,
		HTTPPort:   p.localNode.HTTPPort,
	}
	
	// Try each seed node until we get a successful response
	for _, seed := range seedNodes {
		fmt.Printf("[%s] Attempting to bootstrap from %s\n", p.localNode.ID, seed)
		
		peers, err := p.sendBootstrapRequest(ctx, seed, req)
		if err != nil {
			fmt.Printf("[%s] Failed to bootstrap from %s: %v\n", p.localNode.ID, seed, err)
			continue
		}
		
		// Add all discovered peers
		for _, peer := range peers {
			if peer.ID != p.localNode.ID {
				p.addPeer(peer)
				fmt.Printf("[%s] Discovered peer %s via bootstrap\n", p.localNode.ID, peer.ID)
			}
		}
		
		fmt.Printf("[%s] Bootstrap successful, discovered %d peers\n", p.localNode.ID, len(peers))
		return nil
	}
	
	// If no seed nodes responded, we might be the first node
	fmt.Printf("[%s] No seed nodes available, starting as first node\n", p.localNode.ID)
	return nil
}

func (p *Protocol) sendBootstrapRequest(ctx context.Context, seedAddr string, req *BootstrapRequest) ([]*Node, error) {
	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}
	
	url := fmt.Sprintf("http://%s/bootstrap", seedAddr)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	
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
	fmt.Printf("[%s] Node %s joined via bootstrap\n", p.localNode.ID, req.NodeID)
	
	// Return current cluster topology
	peers := p.getPeers()
	// Include ourselves in the response
	allPeers := append(peers, p.localNode)
	
	return &BootstrapResponse{
		Success: true,
		Peers:   allPeers,
	}
}