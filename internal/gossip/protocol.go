package gossip

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type NodeID string

type Node struct {
	ID      NodeID `json:"id"`
	Address string `json:"address"`
	Port    int    `json:"port"`
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
}

type MessageType string

const (
	MessageTypePut        MessageType = "PUT"
	MessageTypeGet        MessageType = "GET"
	MessageTypePing       MessageType = "PING"
	MessageTypePong       MessageType = "PONG"
	MessageTypeJoin       MessageType = "JOIN"
	MessageTypeLeave      MessageType = "LEAVE"
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
	}
}

func (p *Protocol) SetTransport(transport Transport) {
	p.transport = transport
	transport.SetMessageHandler(p.handleMessage)
}

func (p *Protocol) Start(ctx context.Context, bootstrapNodes []*Node) error {
	if p.transport == nil {
		return fmt.Errorf("transport not set")
	}

	if err := p.transport.Start(ctx); err != nil {
		return fmt.Errorf("failed to start transport: %w", err)
	}

	for _, node := range bootstrapNodes {
		if node.ID != p.localNode.ID {
			p.addPeer(node)
			p.sendJoin(ctx, node)
		}
	}

	go p.startHealthCheck(ctx)
	return nil
}

func (p *Protocol) Stop() error {
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
	switch msg.Type {
	case MessageTypeJoin:
		return p.handleJoin(msg)
	case MessageTypePing:
		return p.handlePing(msg)
	case MessageTypePong:
		return p.handlePong(msg)
	case MessageTypePut:
		return p.handlePut(msg)
	default:
		if p.messageHandler != nil {
			return p.messageHandler(msg)
		}
	}
	return nil
}

func (p *Protocol) handleJoin(msg *Message) error {
	node := &Node{
		ID:      msg.From,
		Address: "unknown", // Would be filled from transport metadata
		Port:    0,
	}
	p.addPeer(node)
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

func (p *Protocol) handlePut(msg *Message) error {
	if p.messageHandler != nil {
		return p.messageHandler(msg)
	}
	return nil
}

func (p *Protocol) sendJoin(ctx context.Context, node *Node) error {
	msg := &Message{
		Type:      MessageTypeJoin,
		From:      p.localNode.ID,
		Timestamp: time.Now(),
		MessageID: generateMessageID(),
	}
	return p.transport.Send(ctx, node, msg)
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
	return p.transport.Broadcast(ctx, msg)
}

func (p *Protocol) GetPeers() []*Node {
	return p.getPeers()
}

func (p *Protocol) SetMessageHandler(handler func(*Message) error) {
	p.messageHandler = handler
}

func generateMessageID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}