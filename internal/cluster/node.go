package cluster

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"repram/internal/gossip"
	"repram/internal/logging"
	"repram/internal/storage"
)

// ErrQuorumTimeout indicates the write was stored locally but quorum
// confirmation was not received within the timeout window. The data
// will still propagate via gossip — this is not a write failure.
var ErrQuorumTimeout = fmt.Errorf("quorum timeout: stored locally, replication pending")

type ClusterNode struct {
	localNode         *gossip.Node
	protocol          *gossip.Protocol
	store             Store
	replicationFactor int
	writeTimeout      time.Duration
	clusterSecret     string

	pendingWrites map[string]*WriteOperation
	writesMutex   sync.RWMutex

	// isRoot tracks whether this node appears in the currently-trusted
	// signed root list. Updated on each successful omega refresh
	// (see cmd/repram/main.go and future phase 4 refresh loop). When
	// false, the HTTP server refuses bootstrap requests with 403.
	isRoot atomic.Bool

	// seedProvider returns the current bootstrap seed list. Used by the
	// isolation-recovery loop to re-bootstrap when peer count drops to 0
	// (#85, F5). Public deployments wire this to the omega refresher's
	// current list; private deployments wire it to the static REPRAM_PEERS
	// list. Nil disables recovery (used for tests and for cases where
	// re-bootstrap doesn't make sense).
	seedProvider func() []string
}

// IsolationRecoveryInterval is how often the recovery loop checks for
// the zero-peer condition. Matches the gossip health-check cadence so
// recovery starts within one tick of full eviction.
const IsolationRecoveryInterval = 30 * time.Second

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
	GetWithMetadata(key string) ([]byte, time.Time, time.Duration, bool) // data, createdAt, originalTTL, exists
	Scan() []string
}

func NewClusterNode(nodeID string, address string, gossipPort int, httpPort int, replicationFactor int, maxStorageBytes int64, writeTimeout time.Duration, clusterSecret string, enclave string) *ClusterNode {
	if enclave == "" {
		enclave = "default"
	}
	localNode := &gossip.Node{
		ID:       gossip.NodeID(nodeID),
		Address:  address,
		Port:     gossipPort,
		HTTPPort: httpPort,
		Enclave:  enclave,
	}

	protocol := gossip.NewProtocol(localNode, replicationFactor, clusterSecret)

	return &ClusterNode{
		localNode:         localNode,
		protocol:          protocol,
		store:             storage.NewMemoryStore(maxStorageBytes),
		replicationFactor: replicationFactor,
		writeTimeout:      writeTimeout,
		clusterSecret:     clusterSecret,
		pendingWrites:     make(map[string]*WriteOperation),
	}
}

func (cn *ClusterNode) Start(ctx context.Context, bootstrapAddresses []string) error {
	transport := gossip.NewHTTPTransport(cn.localNode, cn.clusterSecret)
	cn.protocol.SetTransport(transport)
	cn.protocol.SetMessageHandler(cn.handleGossipMessage)
	cn.protocol.EnableMetrics()

	// Start the gossip protocol
	if err := cn.protocol.Start(ctx); err != nil {
		return fmt.Errorf("failed to start gossip protocol: %w", err)
	}

	// Bootstrap from seed nodes
	if len(bootstrapAddresses) > 0 {
		logging.Info("[%s] Bootstrapping from %d seed nodes", cn.localNode.ID, len(bootstrapAddresses))
		if err := cn.protocol.Bootstrap(ctx, bootstrapAddresses); err != nil {
			// Bootstrap failure is not fatal - we might be the first node
			logging.Warn("[%s] Bootstrap completed with warning: %v", cn.localNode.ID, err)
		}
	} else {
		logging.Info("[%s] Starting as first node (no bootstrap addresses)", cn.localNode.ID)
	}

	go cn.runIsolationRecovery(ctx)

	return nil
}

// SetSeedProvider wires a callback that returns the current bootstrap
// seed list. The isolation-recovery loop calls it whenever peer count
// drops to 0 to attempt re-bootstrap. Nil disables recovery (#85, F5).
func (cn *ClusterNode) SetSeedProvider(p func() []string) {
	cn.seedProvider = p
}

// runIsolationRecovery polls peer count on IsolationRecoveryInterval
// and triggers re-bootstrap when the node is fully isolated (#85, F5).
//
// Why polling rather than event-driven from removePeer: multi-eviction
// in a single pingPeers tick can fire several removals back-to-back, and
// triggering from each would either spawn duplicate recoveries or
// require single-flight machinery. Polling also catches isolation that
// happens via paths other than ping eviction.
func (cn *ClusterNode) runIsolationRecovery(ctx context.Context) {
	ticker := time.NewTicker(IsolationRecoveryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cn.CheckIsolationAndRecover(ctx)
		}
	}
}

// CheckIsolationAndRecover runs one isolation-recovery cycle. Returns
// true if a re-bootstrap was attempted AND it found at least one peer.
// Public so tests can drive recovery deterministically without timers.
func (cn *ClusterNode) CheckIsolationAndRecover(ctx context.Context) bool {
	if len(cn.protocol.GetPeers()) > 0 {
		return false
	}
	if cn.seedProvider == nil {
		return false
	}
	seeds := cn.seedProvider()
	if len(seeds) == 0 {
		return false
	}
	logging.Warn("[%s] Isolated (0 peers) — re-bootstrapping against %d seeds",
		cn.localNode.ID, len(seeds))
	if err := cn.protocol.Bootstrap(ctx, seeds); err != nil {
		logging.Warn("[%s] Re-bootstrap failed: %v", cn.localNode.ID, err)
		return false
	}
	after := len(cn.protocol.GetPeers())
	if after > 0 {
		logging.Info("[%s] Re-bootstrap recovered %d peers", cn.localNode.ID, after)
		return true
	}
	logging.Warn("[%s] Re-bootstrap completed but discovered no peers; will retry next cycle",
		cn.localNode.ID)
	return false
}

func (cn *ClusterNode) Stop() error {
	return cn.protocol.Stop()
}

// IsRoot reports whether this node's advertised address is present in the
// currently-trusted signed root list. Used by the HTTP server to gate
// bootstrap responses — non-roots return 403 rather than handing out peer
// topology to arbitrary callers.
func (cn *ClusterNode) IsRoot() bool {
	return cn.isRoot.Load()
}

// SetRoot updates the root flag. Call after each verified refresh of the
// omega signed root list.
func (cn *ClusterNode) SetRoot(v bool) {
	cn.isRoot.Store(v)
}

func (cn *ClusterNode) Put(ctx context.Context, key string, data []byte, ttl time.Duration) error {
	quorum := cn.quorumSize()

	msg := &gossip.Message{
		Type:      gossip.MessageTypePut,
		From:      cn.localNode.ID,
		Key:       key,
		Data:      data,
		TTL:       int(ttl.Seconds()),
		Timestamp: time.Now(),
		MessageID: fmt.Sprintf("%s-%d", key, time.Now().UnixNano()),
	}

	writeOp := &WriteOperation{
		Key:           key,
		Data:          data,
		TTL:           ttl,
		Confirmations: 1, // Count local write
		Complete:      make(chan bool, 1),
	}

	// Key on MessageID so concurrent writes to the same key don't
	// collide — each write tracks its own quorum independently.
	cn.writesMutex.Lock()
	cn.pendingWrites[msg.MessageID] = writeOp
	cn.writesMutex.Unlock()

	if err := cn.store.Put(key, data, ttl); err != nil {
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, msg.MessageID)
		cn.writesMutex.Unlock()
		return fmt.Errorf("local write failed: %w", err)
	}

	// Check if local write is sufficient for quorum (single node or single-node enclave)
	if writeOp.Confirmations >= quorum {
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, msg.MessageID)
		cn.writesMutex.Unlock()
		close(writeOp.Complete)
		logging.Debug("Write completed locally (quorum=%d, confirmations=%d)", quorum, writeOp.Confirmations)
		return nil
	}

	logging.Debug("[%s] Broadcasting PUT for key %s to enclave peers", cn.localNode.ID, key)
	if err := cn.protocol.BroadcastToEnclave(ctx, msg); err != nil {
		logging.Warn("[%s] Failed to broadcast write to enclave: %v", cn.localNode.ID, err)
	}

	select {
	case <-writeOp.Complete:
		cn.writesMutex.Lock()
		err := writeOp.Error
		delete(cn.pendingWrites, msg.MessageID)
		cn.writesMutex.Unlock()
		return err
	case <-time.After(cn.writeTimeout):
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, msg.MessageID)
		cn.writesMutex.Unlock()
		return ErrQuorumTimeout
	case <-ctx.Done():
		cn.writesMutex.Lock()
		delete(cn.pendingWrites, msg.MessageID)
		cn.writesMutex.Unlock()
		return ctx.Err()
	}
}

func (cn *ClusterNode) Get(key string) ([]byte, bool) {
	return cn.store.Get(key)
}

func (cn *ClusterNode) GetWithMetadata(key string) ([]byte, time.Time, time.Duration, bool) {
	return cn.store.GetWithMetadata(key)
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
		logging.Warn("[%s] Unexpected %s message in cluster handler", cn.localNode.ID, msg.Type)
		return nil
	case gossip.MessageTypePut:
		return cn.handlePutMessage(msg)
	case gossip.MessageTypeAck:
		return cn.handleAckMessage(msg)
	}
	return nil
}

func (cn *ClusterNode) handlePutMessage(msg *gossip.Message) error {
	// Dedup: if we've already processed this message, skip it.
	// MarkSeen returns true if it was already seen.
	if cn.protocol.MarkSeen(msg.MessageID) {
		logging.Debug("[%s] Skipping duplicate PUT for key %s (msg %s)", cn.localNode.ID, msg.Key, msg.MessageID)
		return nil
	}

	logging.Debug("[%s] Received PUT message for key %s from %s", cn.localNode.ID, msg.Key, msg.From)
	ttl := time.Duration(msg.TTL) * time.Second
	if err := cn.store.Put(msg.Key, msg.Data, ttl); err != nil {
		return fmt.Errorf("failed to store replicated data: %w", err)
	}
	logging.Debug("[%s] Successfully stored replicated data for key %s", cn.localNode.ID, msg.Key)

	// Send ACK directly to the originator
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
			logging.Debug("[%s] Sending ACK for key %s to %s", cn.localNode.ID, msg.Key, peer.ID)
			cn.protocol.Send(context.Background(), peer, ack)
			break
		}
	}

	// Continue epidemic forwarding to other enclave peers
	cn.protocol.ForwardToEnclave(context.Background(), msg)

	return nil
}

func (cn *ClusterNode) handleAckMessage(msg *gossip.Message) error {
	cn.writesMutex.Lock()
	defer cn.writesMutex.Unlock()

	writeOp, exists := cn.pendingWrites[msg.MessageID]
	if !exists {
		return nil
	}

	writeOp.Confirmations++

	if writeOp.Confirmations >= cn.quorumSize() {
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

// quorumSize calculates the current quorum based on enclave peer count.
// Quorum = (min(enclaveNodes, replicationFactor) / 2) + 1
// where enclaveNodes includes the local node.
func (cn *ClusterNode) quorumSize() int {
	enclaveNodes := len(cn.protocol.GetReplicationPeers()) + 1 // +1 for self
	effective := enclaveNodes
	if cn.replicationFactor < effective {
		effective = cn.replicationFactor
	}
	q := (effective / 2) + 1
	if q < 1 {
		q = 1
	}
	return q
}

// ClusterSecret returns the configured cluster secret (empty string if open mode).
func (cn *ClusterNode) ClusterSecret() string {
	return cn.clusterSecret
}

// Enclave returns this node's enclave name.
func (cn *ClusterNode) Enclave() string {
	return cn.localNode.Enclave
}

// Topology returns the full peer list with enclave membership.
func (cn *ClusterNode) Topology() []*gossip.Node {
	return cn.protocol.GetPeers()
}
