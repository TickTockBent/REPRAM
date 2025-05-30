package gossip

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type NodeID string

type Node struct {
	ID         NodeID `json:"id"`
	Address    string `json:"address"`
	Port       int    `json:"port"`        // Gossip port
	HTTPPort   int    `json:"http_port"`   // HTTP API port
}

func (n *Node) String() string {
	return fmt.Sprintf("%s@%s:%d", n.ID, n.Address, n.Port)
}

type Message struct {
	Type      MessageType `json:"type"`
	From      NodeID      `json:"from"`
	To        NodeID      `json:"to,omitempty"`
	Key       string      `json:"key,omitempty"`
	Data      []byte      `json:"data,omitempty"`
	TTL       int         `json:"ttl,omitempty"`
	Timestamp time.Time   `json:"timestamp"`
	MessageID string      `json:"message_id"`
	// Node information for JOIN messages
	NodeInfo  *Node       `json:"node_info,omitempty"`
}

type MessageType string

const (
	MessageTypePut        MessageType = "PUT"
	MessageTypeGet        MessageType = "GET"
	MessageTypePing       MessageType = "PING"
	MessageTypePong       MessageType = "PONG"
	MessageTypeSync       MessageType = "SYNC"
	MessageTypeAck        MessageType = "ACK"
)

type Protocol struct {
	localNode      *Node
	peers          map[NodeID]*Node
	peersMutex     sync.RWMutex
	replicationFactor int
	quorumSize     int
	messageHandler func(*Message) error
	transport      Transport
	topologyTicker *time.Ticker
	stopChan       chan struct{}
}

type Transport interface {
	Start(ctx context.Context) error
	Stop() error
	Send(ctx context.Context, node *Node, msg *Message) error
	Broadcast(ctx context.Context, msg *Message) error
	SetMessageHandler(handler func(*Message) error)
}

func NewProtocol(localNode *Node, replicationFactor int) *Protocol {
	quorumSize := (replicationFactor / 2) + 1
	return &Protocol{
		localNode:         localNode,
		peers:            make(map[NodeID]*Node),
		replicationFactor: replicationFactor,
		quorumSize:       quorumSize,
		stopChan:         make(chan struct{}),
	}
}

func (p *Protocol) SetTransport(transport Transport) {
	p.transport = transport
	// Always use protocol's handleMessage which will delegate to app handler
	transport.SetMessageHandler(p.handleMessage)
}

func (p *Protocol) Start(ctx context.Context) error {
	if p.transport == nil {
		return fmt.Errorf("transport not set")
	}

	if err := p.transport.Start(ctx); err != nil {
		return fmt.Errorf("failed to start transport: %w", err)
	}

	// Start periodic health checks
	go p.startHealthCheck(ctx)
	
	// Start periodic topology synchronization
	go p.startTopologySync(ctx)
	
	fmt.Printf("[%s] Gossip protocol started\n", p.localNode.ID)
	return nil
}

func (p *Protocol) Stop() error {
	// Stop topology sync
	close(p.stopChan)
	if p.topologyTicker != nil {
		p.topologyTicker.Stop()
	}
	
	if p.transport != nil {
		return p.transport.Stop()
	}
	return nil
}

func (p *Protocol) addPeer(node *Node) {
	p.peersMutex.Lock()
	defer p.peersMutex.Unlock()
	p.peers[node.ID] = node
}

func (p *Protocol) removePeer(nodeID NodeID) {
	p.peersMutex.Lock()
	defer p.peersMutex.Unlock()
	delete(p.peers, nodeID)
}

func (p *Protocol) getPeers() []*Node {
	p.peersMutex.RLock()
	defer p.peersMutex.RUnlock()
	
	peers := make([]*Node, 0, len(p.peers))
	for _, peer := range p.peers {
		peers = append(peers, peer)
	}
	return peers
}

func (p *Protocol) handleMessage(msg *Message) error {
	// Handle protocol-level messages first
	switch msg.Type {
	case MessageTypePing:
		return p.handlePing(msg)
	case MessageTypePong:
		return p.handlePong(msg)
	case MessageTypeSync:
		return p.handleSync(msg)
	case MessageTypePut, MessageTypeAck:
		// Application-level messages - pass to handler
		if p.messageHandler != nil {
			return p.messageHandler(msg)
		}
		return nil
	default:
		// Unknown message type
		if p.messageHandler != nil {
			return p.messageHandler(msg)
		}
	}
	return nil
}


func (p *Protocol) handlePing(msg *Message) error {
	pong := &Message{
		Type:      MessageTypePong,
		From:      p.localNode.ID,
		To:        msg.From,
		Timestamp: time.Now(),
		MessageID: generateMessageID(),
	}
	
	p.peersMutex.RLock()
	peer := p.peers[msg.From]
	p.peersMutex.RUnlock()
	
	if peer != nil {
		return p.transport.Send(context.Background(), peer, pong)
	}
	return nil
}

func (p *Protocol) handlePong(msg *Message) error {
	return nil
}


func (p *Protocol) handleSync(msg *Message) error {
	fmt.Printf("[%s] Received SYNC message from %s\n", p.localNode.ID, msg.From)
	
	// SYNC messages carry information about new nodes
	if msg.NodeInfo != nil {
		// Check if we already know this peer
		p.peersMutex.RLock()
		_, exists := p.peers[msg.NodeInfo.ID]
		p.peersMutex.RUnlock()
		
		if !exists {
			p.addPeer(msg.NodeInfo)
			fmt.Printf("[%s] Learned about new peer %s via SYNC from %s\n", 
				p.localNode.ID, msg.NodeInfo.ID, msg.From)
		} else {
			fmt.Printf("[%s] Already know peer %s (SYNC from %s)\n", 
				p.localNode.ID, msg.NodeInfo.ID, msg.From)
		}
	} else {
		fmt.Printf("[%s] SYNC message from %s has no NodeInfo\n", p.localNode.ID, msg.From)
	}
	return nil
}


func (p *Protocol) startHealthCheck(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.pingPeers(ctx)
		}
	}
}

func (p *Protocol) pingPeers(ctx context.Context) {
	peers := p.getPeers()
	for _, peer := range peers {
		ping := &Message{
			Type:      MessageTypePing,
			From:      p.localNode.ID,
			To:        peer.ID,
			Timestamp: time.Now(),
			MessageID: generateMessageID(),
		}
		p.transport.Send(ctx, peer, ping)
	}
}

func (p *Protocol) Send(ctx context.Context, node *Node, msg *Message) error {
	if p.transport == nil {
		return fmt.Errorf("transport not set")
	}
	return p.transport.Send(ctx, node, msg)
}

func (p *Protocol) Broadcast(ctx context.Context, msg *Message) error {
	if p.transport == nil {
		return fmt.Errorf("transport not set")
	}
	
	// Send to all known peers
	peers := p.getPeers()
	fmt.Printf("[%s] Broadcasting %s message to %d peers\n", p.localNode.ID, msg.Type, len(peers))
	for _, peer := range peers {
		fmt.Printf("[%s] Sending %s to peer %s\n", p.localNode.ID, msg.Type, peer.ID)
		if err := p.transport.Send(ctx, peer, msg); err != nil {
			fmt.Printf("[%s] Failed to send to peer %s: %v\n", p.localNode.ID, peer.ID, err)
			// Continue to other peers even if one fails
		}
	}
	
	return nil
}

func (p *Protocol) GetPeers() []*Node {
	return p.getPeers()
}

func (p *Protocol) SetMessageHandler(handler func(*Message) error) {
	p.messageHandler = handler
}

// HandleMessage is the public entry point for processing messages
func (p *Protocol) HandleMessage(msg *Message) error {
	return p.handleMessage(msg)
}

func generateMessageID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// startTopologySync periodically exchanges peer lists to fix broken topology
func (p *Protocol) startTopologySync(ctx context.Context) {
	p.topologyTicker = time.NewTicker(30 * time.Second) // Sync every 30 seconds
	defer p.topologyTicker.Stop()
	
	for {
		select {
		case <-p.topologyTicker.C:
			p.performTopologySync(ctx)
		case <-p.stopChan:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (p *Protocol) performTopologySync(ctx context.Context) {
	p.peersMutex.RLock()
	peerCount := len(p.peers)
	expectedPeers := p.replicationFactor - 1 // Don't count ourselves
	p.peersMutex.RUnlock()
	
	// Only sync if we have fewer peers than expected
	if peerCount >= expectedPeers {
		return
	}
	
	fmt.Printf("[%s] Topology sync: have %d peers, expected %d - requesting peer lists\n", 
		p.localNode.ID, peerCount, expectedPeers)
	
	// Send SYNC requests to all known peers to get their peer lists
	msg := &Message{
		Type:      MessageTypeSync,
		From:      p.localNode.ID,
		Timestamp: time.Now(),
		MessageID: generateMessageID(),
		NodeInfo:  p.localNode, // Include our own node info
	}
	
	// Broadcast to all known peers
	if err := p.Broadcast(ctx, msg); err != nil {
		fmt.Printf("[%s] Failed to broadcast topology sync: %v\n", p.localNode.ID, err)
	}
}