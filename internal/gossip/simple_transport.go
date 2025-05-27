package gossip

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"
)

// SimpleGRPCTransport - simplified transport without protobuf
type SimpleGRPCTransport struct {
	localNode      *Node
	server         *SimpleGossipServer
	listener       net.Listener
	messageHandler func(*Message) error
	running        bool
	stopCh         chan struct{}
	mutex          sync.RWMutex
}

func NewSimpleGRPCTransport(localNode *Node) *SimpleGRPCTransport {
	return &SimpleGRPCTransport{
		localNode: localNode,
		stopCh:    make(chan struct{}),
	}
}

func (t *SimpleGRPCTransport) Start(ctx context.Context) error {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	if t.running {
		return nil
	}
	
	address := fmt.Sprintf(":%d", t.localNode.Port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", address, err)
	}
	
	t.listener = listener
	t.server = NewSimpleGossipServer(t.handleSimpleMessage)
	t.running = true
	
	go func() {
		defer listener.Close()
		for {
			select {
			case <-t.stopCh:
				return
			default:
				// Accept connections in a simple way
				conn, err := listener.Accept()
				if err != nil {
					select {
					case <-t.stopCh:
						return
					default:
						fmt.Printf("Accept error: %v\n", err)
						continue
					}
				}
				
				// Handle connection in goroutine
				go func() {
					defer conn.Close()
					// Simple connection handling - just close for now
					time.Sleep(100 * time.Millisecond)
				}()
			}
		}
	}()
	
	fmt.Printf("Simple transport started on %s\n", address)
	return nil
}

func (t *SimpleGRPCTransport) Stop() error {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	if !t.running {
		return nil
	}
	
	close(t.stopCh)
	t.running = false
	
	if t.listener != nil {
		t.listener.Close()
	}
	
	return nil
}

func (t *SimpleGRPCTransport) Send(ctx context.Context, node *Node, msg *Message) error {
	// For now, just simulate successful sending
	fmt.Printf("Simulating send message %s to %s:%d\n", msg.Type, node.Address, node.Port)
	return nil
}

func (t *SimpleGRPCTransport) Broadcast(ctx context.Context, msg *Message) error {
	// For now, just simulate successful broadcast
	fmt.Printf("Simulating broadcast message %s\n", msg.Type)
	return nil
}

func (t *SimpleGRPCTransport) SetMessageHandler(handler func(*Message) error) {
	t.messageHandler = handler
}

func (t *SimpleGRPCTransport) handleSimpleMessage(msg *SimpleMessage) error {
	if t.messageHandler == nil {
		return nil
	}
	
	// Convert SimpleMessage to Message
	gossipMsg := &Message{
		Type:      MessageType(msg.Type),
		From:      NodeID(msg.From),
		To:        NodeID(msg.To),
		Key:       msg.Key,
		Data:      msg.Data,
		TTL:       int(msg.TTL),
		Timestamp: time.Unix(msg.Timestamp, 0),
		MessageID: msg.MessageID,
	}
	
	return t.messageHandler(gossipMsg)
}