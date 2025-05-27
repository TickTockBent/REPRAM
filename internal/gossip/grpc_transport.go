package gossip

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type GRPCTransport struct {
	localNode      *Node
	server         *grpc.Server
	listener       net.Listener
	connections    map[NodeID]*grpc.ClientConn
	connMutex      sync.RWMutex
	messageHandler func(*Message) error
}

func NewGRPCTransport(localNode *Node) *GRPCTransport {
	return &GRPCTransport{
		localNode:   localNode,
		connections: make(map[NodeID]*grpc.ClientConn),
	}
}

func (t *GRPCTransport) Start(ctx context.Context) error {
	address := fmt.Sprintf(":%d", t.localNode.Port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", address, err)
	}
	
	t.listener = listener
	t.server = grpc.NewServer()
	
	RegisterGossipServiceServer(t.server, &gossipServer{transport: t})
	
	go func() {
		if err := t.server.Serve(listener); err != nil {
			fmt.Printf("gRPC server error: %v\n", err)
		}
	}()
	
	return nil
}

func (t *GRPCTransport) Stop() error {
	if t.server != nil {
		t.server.Stop()
	}
	
	t.connMutex.Lock()
	defer t.connMutex.Unlock()
	
	for _, conn := range t.connections {
		conn.Close()
	}
	t.connections = make(map[NodeID]*grpc.ClientConn)
	
	return nil
}

func (t *GRPCTransport) Send(ctx context.Context, node *Node, msg *Message) error {
	conn, err := t.getConnection(node)
	if err != nil {
		return fmt.Errorf("failed to get connection to %s: %w", node, err)
	}
	
	client := NewGossipServiceClient(conn)
	protoMsg := messageToProto(msg)
	
	_, err = client.SendMessage(ctx, protoMsg)
	return err
}

func (t *GRPCTransport) Broadcast(ctx context.Context, msg *Message) error {
	t.connMutex.RLock()
	defer t.connMutex.RUnlock()
	
	var lastErr error
	for nodeID, conn := range t.connections {
		client := NewGossipServiceClient(conn)
		protoMsg := messageToProto(msg)
		
		if err := func() error {
			_, err := client.SendMessage(ctx, protoMsg)
			return err
		}(); err != nil {
			fmt.Printf("Failed to send message to %s: %v\n", nodeID, err)
			lastErr = err
		}
	}
	
	return lastErr
}

func (t *GRPCTransport) SetMessageHandler(handler func(*Message) error) {
	t.messageHandler = handler
}

func (t *GRPCTransport) getConnection(node *Node) (*grpc.ClientConn, error) {
	t.connMutex.RLock()
	if conn, exists := t.connections[node.ID]; exists {
		t.connMutex.RUnlock()
		return conn, nil
	}
	t.connMutex.RUnlock()
	
	t.connMutex.Lock()
	defer t.connMutex.Unlock()
	
	if conn, exists := t.connections[node.ID]; exists {
		return conn, nil
	}
	
	address := fmt.Sprintf("%s:%d", node.Address, node.Port)
	conn, err := grpc.Dial(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	
	t.connections[node.ID] = conn
	return conn, nil
}

type gossipServer struct {
	UnimplementedGossipServiceServer
	transport *GRPCTransport
}

func (s *gossipServer) SendMessage(ctx context.Context, req *GossipMessage) (*GossipResponse, error) {
	msg := protoToMessage(req)
	
	if s.transport.messageHandler != nil {
		if err := s.transport.messageHandler(msg); err != nil {
			return &GossipResponse{Success: false, Error: err.Error()}, nil
		}
	}
	
	return &GossipResponse{Success: true}, nil
}

func messageToProto(msg *Message) *GossipMessage {
	return &GossipMessage{
		Type:      string(msg.Type),
		From:      string(msg.From),
		To:        string(msg.To),
		Key:       msg.Key,
		Data:      msg.Data,
		Ttl:       int32(msg.TTL),
		Timestamp: msg.Timestamp.Unix(),
		MessageId: msg.MessageID,
	}
}

func protoToMessage(proto *GossipMessage) *Message {
	return &Message{
		Type:      MessageType(proto.Type),
		From:      NodeID(proto.From),
		To:        NodeID(proto.To),
		Key:       proto.Key,
		Data:      proto.Data,
		TTL:       int(proto.Ttl),
		Timestamp: timeFromUnix(proto.Timestamp),
		MessageID: proto.MessageId,
	}
}

func timeFromUnix(unix int64) time.Time {
	return time.Unix(unix, 0)
}