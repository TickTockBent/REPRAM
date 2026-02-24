package gossip

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"repram/internal/logging"
)

type NodeID string

type Node struct {
	ID       NodeID `json:"id"`
	Address  string `json:"address"`
	Port     int    `json:"port"`      // Gossip port
	HTTPPort int    `json:"http_port"` // HTTP API port
	Enclave  string `json:"enclave"`   // Replication boundary (default: "default")
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

// MaxPingFailures is the number of consecutive failed health checks before
// a peer is evicted from the peer list. With a 30-second ping interval this
// means a peer is removed after ~90 seconds of unreachability. Evicted peers
// rejoin automatically if they come back online and re-bootstrap.
const MaxPingFailures = 3

type Protocol struct {
	localNode         *Node
	peers             map[NodeID]*Node
	peerFailures      map[NodeID]int // consecutive ping failures per peer
	peersMutex        sync.RWMutex
	replicationFactor int
	quorumSize        int
	clusterSecret     string
	messageHandler    func(*Message) error
	transport         Transport
	topologyTicker    *time.Ticker
	stopChan          chan struct{}
}

type Transport interface {
	Start(ctx context.Context) error
	Stop() error
	Send(ctx context.Context, node *Node, msg *Message) error
	Broadcast(ctx context.Context, msg *Message) error
	SetMessageHandler(handler func(*Message) error)
}

func NewProtocol(localNode *Node, replicationFactor int, clusterSecret string) *Protocol {
	quorumSize := (replicationFactor / 2) + 1
	return &Protocol{
		localNode:         localNode,
		peers:             make(map[NodeID]*Node),
		peerFailures:      make(map[NodeID]int),
		replicationFactor: replicationFactor,
		quorumSize:        quorumSize,
		clusterSecret:     clusterSecret,
		stopChan:          make(chan struct{}),
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

	// Create ticker before goroutine to avoid data race with Stop()
	p.topologyTicker = time.NewTicker(30 * time.Second)

	// Start periodic health checks
	go p.startHealthCheck(ctx)

	// Start periodic topology synchronization
	go p.startTopologySync(ctx)

	logging.Info("[%s] Gossip protocol started", p.localNode.ID)
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
	delete(p.peerFailures, node.ID) // reset failure counter on (re-)add
}

func (p *Protocol) removePeer(nodeID NodeID) {
	p.peersMutex.Lock()
	defer p.peersMutex.Unlock()
	delete(p.peers, nodeID)
	delete(p.peerFailures, nodeID)
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
		NodeInfo:  p.localNode, // Include our identity and enclave membership
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
	p.peersMutex.Lock()
	// Reset failure counter — peer is alive
	delete(p.peerFailures, msg.From)

	// Update peer's enclave membership if included
	if msg.NodeInfo != nil {
		if msg.NodeInfo.Enclave == "" {
			msg.NodeInfo.Enclave = "default"
		}
		if existing, ok := p.peers[msg.NodeInfo.ID]; ok && existing.Enclave != msg.NodeInfo.Enclave {
			existing.Enclave = msg.NodeInfo.Enclave
			logging.Debug("[%s] Updated peer %s enclave to %s via PONG", p.localNode.ID, msg.NodeInfo.ID, msg.NodeInfo.Enclave)
		}
	}
	p.peersMutex.Unlock()
	return nil
}

func (p *Protocol) handleSync(msg *Message) error {
	logging.Debug("[%s] Received SYNC message from %s", p.localNode.ID, msg.From)

	// SYNC messages carry information about new nodes
	if msg.NodeInfo != nil {
		// Normalize empty enclave to "default" (backwards compat with pre-enclave nodes)
		if msg.NodeInfo.Enclave == "" {
			msg.NodeInfo.Enclave = "default"
		}

		// Check if we already know this peer
		p.peersMutex.RLock()
		existing, exists := p.peers[msg.NodeInfo.ID]
		p.peersMutex.RUnlock()

		if !exists {
			p.addPeer(msg.NodeInfo)
			logging.Info("[%s] Learned about new peer %s (enclave: %s) via SYNC from %s",
				p.localNode.ID, msg.NodeInfo.ID, msg.NodeInfo.Enclave, msg.From)
		} else if existing.Enclave != msg.NodeInfo.Enclave {
			// Update enclave if it changed (e.g., node upgraded and now reports enclave)
			p.addPeer(msg.NodeInfo)
			logging.Info("[%s] Updated peer %s enclave: %s → %s (via SYNC from %s)",
				p.localNode.ID, msg.NodeInfo.ID, existing.Enclave, msg.NodeInfo.Enclave, msg.From)
		} else {
			logging.Debug("[%s] Already know peer %s (SYNC from %s)",
				p.localNode.ID, msg.NodeInfo.ID, msg.From)
		}
	} else {
		logging.Debug("[%s] SYNC message from %s has no NodeInfo", p.localNode.ID, msg.From)
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
	var evictions []NodeID

	for _, peer := range peers {
		ping := &Message{
			Type:      MessageTypePing,
			From:      p.localNode.ID,
			To:        peer.ID,
			Timestamp: time.Now(),
			MessageID: generateMessageID(),
		}
		if err := p.transport.Send(ctx, peer, ping); err != nil {
			p.peersMutex.Lock()
			p.peerFailures[peer.ID]++
			failures := p.peerFailures[peer.ID]
			p.peersMutex.Unlock()

			logging.Warn("[%s] Ping failed for peer %s (%d/%d): %v",
				p.localNode.ID, peer.ID, failures, MaxPingFailures, err)

			if failures >= MaxPingFailures {
				evictions = append(evictions, peer.ID)
			}
		}
	}

	for _, id := range evictions {
		p.removePeer(id)
		logging.Info("[%s] Evicted peer %s after %d consecutive ping failures",
			p.localNode.ID, id, MaxPingFailures)
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
	logging.Debug("[%s] Broadcasting %s message to %d peers", p.localNode.ID, msg.Type, len(peers))
	for _, peer := range peers {
		logging.Debug("[%s] Sending %s to peer %s", p.localNode.ID, msg.Type, peer.ID)
		if err := p.transport.Send(ctx, peer, msg); err != nil {
			logging.Warn("[%s] Failed to send to peer %s: %v", p.localNode.ID, peer.ID, err)
			// Continue to other peers even if one fails
		}
	}

	return nil
}

// BroadcastToEnclave sends a message only to peers in the same enclave.
// Used for data replication (PUT messages). Topology messages (SYNC, PING)
// use Broadcast() which reaches all peers regardless of enclave.
func (p *Protocol) BroadcastToEnclave(ctx context.Context, msg *Message) error {
	if p.transport == nil {
		return fmt.Errorf("transport not set")
	}

	peers := p.GetReplicationPeers()
	logging.Debug("[%s] Broadcasting %s to %d enclave peers (%s)", p.localNode.ID, msg.Type, len(peers), p.localNode.Enclave)
	for _, peer := range peers {
		logging.Debug("[%s] Sending %s to enclave peer %s", p.localNode.ID, msg.Type, peer.ID)
		if err := p.transport.Send(ctx, peer, msg); err != nil {
			logging.Warn("[%s] Failed to send to enclave peer %s: %v", p.localNode.ID, peer.ID, err)
		}
	}

	return nil
}

func (p *Protocol) GetPeers() []*Node {
	return p.getPeers()
}

// GetReplicationPeers returns only peers in the same enclave as the local node.
func (p *Protocol) GetReplicationPeers() []*Node {
	p.peersMutex.RLock()
	defer p.peersMutex.RUnlock()

	var peers []*Node
	for _, peer := range p.peers {
		if peer.Enclave == p.localNode.Enclave {
			peers = append(peers, peer)
		}
	}
	return peers
}

// PeerFailureCount returns the number of consecutive ping failures for a peer.
func (p *Protocol) PeerFailureCount(id NodeID) int {
	p.peersMutex.RLock()
	defer p.peersMutex.RUnlock()
	return p.peerFailures[id]
}

func (p *Protocol) SetMessageHandler(handler func(*Message) error) {
	p.messageHandler = handler
}

// HandleMessage is the public entry point for processing messages
func (p *Protocol) HandleMessage(msg *Message) error {
	return p.handleMessage(msg)
}

var messageCounter uint64

func generateMessageID() string {
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), atomic.AddUint64(&messageCounter, 1))
}

// startTopologySync periodically exchanges peer lists to fix broken topology.
// The ticker is created in Start() before this goroutine is launched.
func (p *Protocol) startTopologySync(ctx context.Context) {
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

	logging.Debug("[%s] Topology sync: have %d peers, expected %d - requesting peer lists",
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
		logging.Warn("[%s] Failed to broadcast topology sync: %v", p.localNode.ID, err)
	}
}
