package cluster

import (
	"context"
	"fmt"
	"strconv"
	"strings"
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
}

func NewClusterNode(nodeID string, address string, port int, replicationFactor int) *ClusterNode {
	localNode := &gossip.Node{
		ID:      gossip.NodeID(nodeID),
		Address: address,
		Port:    port,
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

func (cn *ClusterNode) Start(ctx context.Context, bootstrapNodes []string) error {
	transport := gossip.NewSimpleGRPCTransport(cn.localNode)
	cn.protocol.SetTransport(transport)
	cn.protocol.SetMessageHandler(cn.handleGossipMessage)
	
	var bootstrapNodeList []*gossip.Node
	for _, addr := range bootstrapNodes {
		// Skip empty addresses
		if addr == "" {
			continue
		}
		
		// Skip if this is our own address
		if addr == fmt.Sprintf("%s:%d", cn.localNode.Address, cn.localNode.Port) {
			continue
		}
		
		// Parse host:port
		parts := strings.Split(addr, ":")
		if len(parts) != 2 {
			fmt.Printf("Warning: invalid bootstrap address format: %s\n", addr)
			continue
		}
		
		host := parts[0]
		portStr := parts[1]
		port, err := strconv.Atoi(portStr)
		if err != nil {
			fmt.Printf("Warning: invalid port in bootstrap address: %s\n", addr)
			continue
		}
		
		bootstrapNodeList = append(bootstrapNodeList, &gossip.Node{
			ID:      gossip.NodeID(fmt.Sprintf("bootstrap-%s-%d", host, port)),
			Address: host,
			Port:    port,
		})
	}
	
	fmt.Printf("Starting cluster node with %d bootstrap peers: %v\n", len(bootstrapNodeList), bootstrapNodes)
	return cn.protocol.Start(ctx, bootstrapNodeList)
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
	
	msg := &gossip.Message{
		Type:      gossip.MessageTypePut,
		From:      cn.localNode.ID,
		Key:       key,
		Data:      data,
		TTL:       int(ttl.Seconds()),
		Timestamp: time.Now(),
		MessageID: fmt.Sprintf("%s-%d", key, time.Now().UnixNano()),
	}
	
	if err := cn.protocol.Broadcast(ctx, msg); err != nil {
		fmt.Printf("Failed to broadcast write: %v\n", err)
	}
	
	select {
	case <-writeOp.Complete:
		cn.writesMutex.Lock()
		err := writeOp.Error
		delete(cn.pendingWrites, key)
		cn.writesMutex.Unlock()
		return err
	case <-time.After(5 * time.Second):
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

func (cn *ClusterNode) handleGossipMessage(msg *gossip.Message) error {
	switch msg.Type {
	case gossip.MessageTypePut:
		return cn.handlePutMessage(msg)
	case gossip.MessageTypeAck:
		return cn.handleAckMessage(msg)
	}
	return nil
}

func (cn *ClusterNode) handlePutMessage(msg *gossip.Message) error {
	ttl := time.Duration(msg.TTL) * time.Second
	if err := cn.store.Put(msg.Key, msg.Data, ttl); err != nil {
		return fmt.Errorf("failed to store replicated data: %w", err)
	}
	
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
			return cn.protocol.Send(context.Background(), peer, ack)
		}
	}
	
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