package cluster

import (
	"context"
	"fmt"
	"sync"
	"time"

	"repram/internal/gossip"
	"repram/internal/storage"
)

type ClusterNode struct {
	localNode  *gossip.Node
	protocol   *gossip.Protocol
	store      Store
	quorumSize int
	
	pendingWrites map[string]*WriteOperation
	writesMutex   sync.RWMutex
}

type WriteOperation struct {
	Key         string
	Data        []byte
	TTL         time.Duration
	Confirmations int
	Complete    chan bool
	Error       error
}

type Store interface {
	Put(key string, data []byte, ttl time.Duration) error
	Get(key string) ([]byte, bool)
	Scan() []string
}

func NewClusterNode(nodeID string, address string, gossipPort int, httpPort int, replicationFactor int) *ClusterNode {
	localNode := &gossip.Node{
		ID:       gossip.NodeID(nodeID),
		Address:  address,
		Port:     gossipPort,
		HTTPPort: httpPort,
	}
	
	protocol := gossip.NewProtocol(localNode, replicationFactor)
	
	// For single node deployment, quorum size should be 1
	quorumSize := (replicationFactor / 2) + 1
	if quorumSize < 1 {
		quorumSize = 1
	}
	
	return &ClusterNode{
		localNode:     localNode,
		protocol:      protocol,
		store:         storage.NewMemoryStore(),
		quorumSize:    quorumSize,
		pendingWrites: make(map[string]*WriteOperation),
	}
}

func (cn *ClusterNode) Start(ctx context.Context, bootstrapAddresses []string) error {
	transport := gossip.NewSimpleGRPCTransport(cn.localNode)
	cn.protocol.SetTransport(transport)
	cn.protocol.SetMessageHandler(cn.handleGossipMessage)
	
	// Start the gossip protocol
	if err := cn.protocol.Start(ctx); err != nil {
		return fmt.Errorf("failed to start gossip protocol: %w", err)
	}
	
	// Bootstrap from seed nodes
	if len(bootstrapAddresses) > 0 {
		fmt.Printf("[%s] Bootstrapping from %d seed nodes\n", cn.localNode.ID, len(bootstrapAddresses))
		if err := cn.protocol.Bootstrap(ctx, bootstrapAddresses); err != nil {
			// Bootstrap failure is not fatal - we might be the first node
			fmt.Printf("[%s] Bootstrap completed with warning: %v\n", cn.localNode.ID, err)
		}
	} else {
		fmt.Printf("[%s] Starting as first node (no bootstrap addresses)\n", cn.localNode.ID)
	}
	
	return nil
}

func (cn *ClusterNode) Stop() error {
	return cn.protocol.Stop()
}

func (cn *ClusterNode) Put(ctx context.Context, key string, data []byte, ttl time.Duration) error {
	writeOp := &WriteOperation{
		Key:           key,
		Data:          data,
		TTL:           ttl,
		Confirmations: 1, // Count local write
		Complete:      make(chan bool, 1),
	}
	
	cn.writesMutex.Lock()
	cn.pendingWrites[key] = writeOp
	cn.writesMutex.Unlock()
	
	if err := cn.store.Put(key, data, ttl); err != nil {
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, key)
		cn.writesMutex.Unlock()
		return fmt.Errorf("local write failed: %w", err)
	}
	
	// Check if local write is sufficient for quorum
	if writeOp.Confirmations >= cn.quorumSize {
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, key)
		cn.writesMutex.Unlock()
		close(writeOp.Complete)
		fmt.Printf("Write completed locally (quorum=%d, confirmations=%d)\n", cn.quorumSize, writeOp.Confirmations)
		return nil
	}
	
	msg := &gossip.Message{
		Type:      gossip.MessageTypePut,
		From:      cn.localNode.ID,
		Key:       key,
		Data:      data,
		TTL:       int(ttl.Seconds()),
		Timestamp: time.Now(),
		MessageID: fmt.Sprintf("%s-%d", key, time.Now().UnixNano()),
	}
	
	fmt.Printf("[%s] Broadcasting PUT for key %s to peers\n", cn.localNode.ID, key)
	if err := cn.protocol.Broadcast(ctx, msg); err != nil {
		fmt.Printf("[%s] Failed to broadcast write: %v\n", cn.localNode.ID, err)
	}
	
	select {
	case <-writeOp.Complete:
		cn.writesMutex.Lock()
		err := writeOp.Error
		delete(cn.pendingWrites, key)
		cn.writesMutex.Unlock()
		return err
	case <-time.After(2 * time.Second):
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, key)
		cn.writesMutex.Unlock()
		return fmt.Errorf("write timeout: insufficient replicas")
	case <-ctx.Done():
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, key)
		cn.writesMutex.Unlock()
		return ctx.Err()
	}
}

func (cn *ClusterNode) Get(key string) ([]byte, bool) {
	return cn.store.Get(key)
}

func (cn *ClusterNode) HandleGossipMessage(msg *gossip.Message) error {
	// Route protocol messages to the protocol handler
	switch msg.Type {
	case gossip.MessageTypePing, gossip.MessageTypePong, gossip.MessageTypeSync:
		// Let the protocol handle its own messages
		return cn.protocol.HandleMessage(msg)
	default:
		// Application messages
		return cn.handleGossipMessage(msg)
	}
}

func (cn *ClusterNode) handleGossipMessage(msg *gossip.Message) error {
	// First let the protocol handle system messages
	switch msg.Type {
	case gossip.MessageTypePing, gossip.MessageTypePong, gossip.MessageTypeSync:
		// These are handled by the protocol layer, not the application
		// The protocol's message handler is already set, so this should not happen
		// but we'll handle it gracefully
		fmt.Printf("[%s] Unexpected %s message in cluster handler\n", cn.localNode.ID, msg.Type)
		return nil
	case gossip.MessageTypePut:
		return cn.handlePutMessage(msg)
	case gossip.MessageTypeAck:
		return cn.handleAckMessage(msg)
	}
	return nil
}

func (cn *ClusterNode) handlePutMessage(msg *gossip.Message) error {
	fmt.Printf("[%s] Received PUT message for key %s from %s\n", cn.localNode.ID, msg.Key, msg.From)
	ttl := time.Duration(msg.TTL) * time.Second
	if err := cn.store.Put(msg.Key, msg.Data, ttl); err != nil {
		return fmt.Errorf("failed to store replicated data: %w", err)
	}
	fmt.Printf("[%s] Successfully stored replicated data for key %s\n", cn.localNode.ID, msg.Key)
	
	ack := &gossip.Message{
		Type:      gossip.MessageTypeAck,
		From:      cn.localNode.ID,
		To:        msg.From,
		Key:       msg.Key,
		MessageID: msg.MessageID,
		Timestamp: time.Now(),
	}
	
	cn.writesMutex.RLock()
	peers := cn.protocol.GetPeers()
	cn.writesMutex.RUnlock()
	
	for _, peer := range peers {
		if peer.ID == msg.From {
			fmt.Printf("[%s] Sending ACK for key %s to %s\n", cn.localNode.ID, msg.Key, peer.ID)
			return cn.protocol.Send(context.Background(), peer, ack)
		}
	}
	
	fmt.Printf("[%s] Warning: sender %s not found in peer list for ACK\n", cn.localNode.ID, msg.From)
	return nil
}

func (cn *ClusterNode) handleAckMessage(msg *gossip.Message) error {
	cn.writesMutex.Lock()
	defer cn.writesMutex.Unlock()
	
	writeOp, exists := cn.pendingWrites[msg.Key]
	if !exists {
		return nil
	}
	
	writeOp.Confirmations++
	
	if writeOp.Confirmations >= cn.quorumSize {
		select {
		case writeOp.Complete <- true:
		default:
		}
	}
	
	return nil
}

func (cn *ClusterNode) Scan() []string {
	return cn.store.Scan()
}

func (cn *ClusterNode) HandleBootstrap(req *gossip.BootstrapRequest) *gossip.BootstrapResponse {
	return cn.protocol.HandleBootstrap(req)
}
