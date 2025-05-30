package gossip

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
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
	// Create simple message for HTTP transport
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
	
	// Convert NodeInfo if present
	if msg.NodeInfo != nil {
		simpleMsg.NodeInfo = &SimpleNodeInfo{
			ID:      string(msg.NodeInfo.ID),
			Address: msg.NodeInfo.Address,
			Port:    msg.NodeInfo.Port,
		}
	}
	
	// Send via HTTP to the target node's HTTP port, not gossip port
	// The gossip messages are sent to the HTTP server, not the gossip port
	// For now, assume HTTP port is gossip port - 1000 (9091 -> 8091)
	httpPort := node.Port - 1000
	if httpPort < 1000 {
		httpPort = node.Port // fallback
	}
	url := fmt.Sprintf("http://%s:%d/gossip/message", node.Address, httpPort)
	fmt.Printf("[Transport] Sending %s message to %s (gossip port %d, http port %d)\n", msg.Type, url, node.Port, httpPort)
	return t.sendHTTPMessage(ctx, url, simpleMsg)
}

func (t *SimpleGRPCTransport) Broadcast(ctx context.Context, msg *Message) error {
	// This method should be implemented by the protocol layer that has access to peers
	// For now, just log that a broadcast was attempted
	fmt.Printf("Broadcast message %s attempted\n", msg.Type)
	return nil
}

func (t *SimpleGRPCTransport) sendHTTPMessage(ctx context.Context, url string, msg *SimpleMessage) error {
	jsonData, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send message: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("message rejected with status: %d", resp.StatusCode)
	}
	
	fmt.Printf("Successfully sent %s message to %s\n", msg.Type, url)
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
	
	// Convert NodeInfo if present
	if msg.NodeInfo != nil {
		gossipMsg.NodeInfo = &Node{
			ID:      NodeID(msg.NodeInfo.ID),
			Address: msg.NodeInfo.Address,
			Port:    msg.NodeInfo.Port,
		}
	}
	
	return t.messageHandler(gossipMsg)
}