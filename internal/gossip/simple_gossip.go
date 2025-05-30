package gossip

import (
	"context"
	"fmt"
	"net"

	"google.golang.org/grpc"
)

// Simple message structure without protobuf for now
type SimpleMessage struct {
	Type      string
	From      string
	To        string
	Key       string
	Data      []byte
	TTL       int32
	Timestamp int64
	MessageID string
	NodeInfo  *SimpleNodeInfo `json:"node_info,omitempty"`
}

type SimpleNodeInfo struct {
	ID      string `json:"id"`
	Address string `json:"address"`
	Port    int    `json:"port"`
}

type SimpleResponse struct {
	Success bool
	Error   string
}

// Simple gRPC service interface
type SimpleGossipServiceServer interface {
	SendMessage(context.Context, *SimpleMessage) (*SimpleResponse, error)
}

type SimpleGossipServer struct {
	onMessage func(*SimpleMessage) error
}

func NewSimpleGossipServer(onMessage func(*SimpleMessage) error) *SimpleGossipServer {
	return &SimpleGossipServer{onMessage: onMessage}
}

func (s *SimpleGossipServer) SendMessage(ctx context.Context, msg *SimpleMessage) (*SimpleResponse, error) {
	if s.onMessage != nil {
		if err := s.onMessage(msg); err != nil {
			return &SimpleResponse{Success: false, Error: err.Error()}, nil
		}
	}
	return &SimpleResponse{Success: true}, nil
}

// Simple transport implementation
type SimpleTransport struct {
	localNode *Node
	server    *grpc.Server
	onMessage func(*Message) error
}

func NewSimpleTransport(localNode *Node) *SimpleTransport {
	return &SimpleTransport{
		localNode: localNode,
	}
}

func (st *SimpleTransport) Start(ctx context.Context, onMessage func(*Message) error) error {
	st.onMessage = onMessage
	
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", st.localNode.Port))
	if err != nil {
		return fmt.Errorf("failed to listen: %v", err)
	}

	st.server = grpc.NewServer()
	
	// Register a simple handler
	go func() {
		if err := st.server.Serve(lis); err != nil {
			fmt.Printf("Failed to serve: %v\n", err)
		}
	}()

	fmt.Printf("Simple gossip transport started on port %d\n", st.localNode.Port)
	return nil
}

func (st *SimpleTransport) Stop() error {
	if st.server != nil {
		st.server.Stop()
	}
	return nil
}

func (st *SimpleTransport) Send(ctx context.Context, target *Node, message *Message) error {
	// For now, just simulate successful sending
	fmt.Printf("Simulating send message to %s:%d\n", target.Address, target.Port)
	return nil
}

func (st *SimpleTransport) Broadcast(ctx context.Context, peers []*Node, message *Message) error {
	for _, peer := range peers {
		if err := st.Send(ctx, peer, message); err != nil {
			fmt.Printf("Failed to send to peer %s: %v\n", peer.ID, err)
		}
	}
	return nil
}