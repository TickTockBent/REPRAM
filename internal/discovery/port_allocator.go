package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PortAllocator handles automatic port discovery and allocation
type PortAllocator struct {
	domain        string
	basePort      int
	maxPorts      int
	nodeID        string
	httpPort      int
	gossipPort    int
	activePeers   []int
	mu            sync.RWMutex
	server        *http.Server
	conflictCount int
}

// PeerAnnouncement represents a new peer joining the network
type PeerAnnouncement struct {
	NodeID    string    `json:"node_id"`
	HTTPPort  int       `json:"http_port"`
	Timestamp time.Time `json:"timestamp"`
}

// PeerDeparture represents a peer leaving the network
type PeerDeparture struct {
	NodeID   string `json:"node_id"`
	HTTPPort int    `json:"http_port"`
	Reason   string `json:"reason"`
}

// HealthResponse from a peer node
type HealthResponse struct {
	Status   string `json:"status"`
	NodeID   string `json:"node_id"`
	Port     int    `json:"port"`
	Uptime   int64  `json:"uptime"`
}

// NewPortAllocator creates a new port allocator
func NewPortAllocator(nodeID string) *PortAllocator {
	// Get configuration from environment
	domain := os.Getenv("DISCOVERY_DOMAIN")
	if domain == "" {
		domain = "localhost"
	}

	basePortStr := os.Getenv("BASE_PORT")
	basePort := 8081
	if basePortStr != "" {
		if p, err := strconv.Atoi(basePortStr); err == nil {
			basePort = p
		}
	}

	maxPortsStr := os.Getenv("MAX_PORTS")
	maxPorts := 5
	if maxPortsStr != "" {
		if m, err := strconv.Atoi(maxPortsStr); err == nil {
			maxPorts = m
		}
	}

	return &PortAllocator{
		domain:      domain,
		basePort:    basePort,
		maxPorts:    maxPorts,
		nodeID:      nodeID,
		activePeers: make([]int, 0),
	}
}

// AllocatePort attempts to find and bind to an available port
func (pa *PortAllocator) AllocatePort() (int, int, error) {
	predefinedPorts := make([]int, pa.maxPorts)
	for i := 0; i < pa.maxPorts; i++ {
		predefinedPorts[i] = pa.basePort + i
	}

	// Shuffle ports to reduce collision probability
	rand.Shuffle(len(predefinedPorts), func(i, j int) {
		predefinedPorts[i], predefinedPorts[j] = predefinedPorts[j], predefinedPorts[i]
	})

	maxRetries := 3
	for retry := 0; retry < maxRetries; retry++ {
		for _, port := range predefinedPorts {
			httpPort := port
			gossipPort := port + 1000 // Gossip port offset

			// Try to bind to the HTTP port
			listener, err := net.Listen("tcp", fmt.Sprintf(":%d", httpPort))
			if err != nil {
				log.Printf("Port %d already in use locally, trying next...", httpPort)
				continue
			}
			listener.Close()

			// Try to bind to the gossip port
			gossipListener, err := net.Listen("tcp", fmt.Sprintf(":%d", gossipPort))
			if err != nil {
				log.Printf("Gossip port %d already in use locally, trying next...", gossipPort)
				continue
			}
			gossipListener.Close()

			// Check if another node is already using this port
			if pa.isPortClaimedByPeer(httpPort) {
				log.Printf("Port %d claimed by another node, trying next...", httpPort)
				continue
			}

			// Claim the port with a test server
			if err := pa.claimPort(httpPort); err != nil {
				log.Printf("Failed to claim port %d: %v", httpPort, err)
				continue
			}

			// Double-check for conflicts
			time.Sleep(time.Duration(100+rand.Intn(400)) * time.Millisecond)
			if pa.detectConflict(httpPort) {
				log.Printf("Conflict detected on port %d, backing off...", httpPort)
				pa.releasePort()
				pa.conflictCount++
				time.Sleep(time.Duration(pa.conflictCount*500) * time.Millisecond)
				continue
			}

			pa.httpPort = httpPort
			pa.gossipPort = gossipPort
			log.Printf("Successfully allocated ports: HTTP=%d, Gossip=%d", httpPort, gossipPort)
			return httpPort, gossipPort, nil
		}

		// No ports available, sleep before retry
		sleepDuration := time.Duration((retry+1)*5) * time.Second
		log.Printf("No available ports found, sleeping %v before retry %d/%d", sleepDuration, retry+1, maxRetries)
		time.Sleep(sleepDuration)
	}

	return 0, 0, fmt.Errorf("unable to allocate port after %d retries", maxRetries)
}

// isPortClaimedByPeer checks if a peer is already using this port
func (pa *PortAllocator) isPortClaimedByPeer(port int) bool {
	url := fmt.Sprintf("http://%s:%d/health", pa.domain, port)
	
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var health HealthResponse
		if err := json.NewDecoder(resp.Body).Decode(&health); err == nil {
			// Port is claimed by another node
			if health.NodeID != pa.nodeID {
				return true
			}
		}
	}
	return false
}

// claimPort starts a minimal HTTP server to claim the port
func (pa *PortAllocator) claimPort(port int) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(HealthResponse{
			Status: "claiming",
			NodeID: pa.nodeID,
			Port:   port,
			Uptime: 0,
		})
	})

	pa.server = &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: mux,
	}

	go func() {
		if err := pa.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("Claim server error: %v", err)
		}
	}()

	// Give server time to start
	time.Sleep(100 * time.Millisecond)
	return nil
}

// detectConflict checks if another node is trying to claim the same port
func (pa *PortAllocator) detectConflict(port int) bool {
	url := fmt.Sprintf("http://%s:%d/health", pa.domain, port)
	
	// Make multiple rapid checks
	conflicts := 0
	for i := 0; i < 3; i++ {
		client := &http.Client{Timeout: 1 * time.Second}
		resp, err := client.Get(url)
		if err == nil {
			defer resp.Body.Close()
			
			var health HealthResponse
			if err := json.NewDecoder(resp.Body).Decode(&health); err == nil {
				if health.NodeID != pa.nodeID {
					conflicts++
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}

	// If we see another node ID more than once, there's a conflict
	return conflicts > 1
}

// releasePort stops the claim server
func (pa *PortAllocator) releasePort() {
	if pa.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		pa.server.Shutdown(ctx)
		pa.server = nil
	}
}

// DiscoverPeers finds all active peers in the network
func (pa *PortAllocator) DiscoverPeers() []string {
	pa.mu.Lock()
	defer pa.mu.Unlock()

	peers := []string{}
	pa.activePeers = []int{}

	for i := 0; i < pa.maxPorts; i++ {
		port := pa.basePort + i
		if port == pa.httpPort {
			continue // Skip self
		}

		url := fmt.Sprintf("http://%s:%d/health", pa.domain, port)
		client := &http.Client{Timeout: 2 * time.Second}
		
		resp, err := client.Get(url)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var health HealthResponse
			if err := json.NewDecoder(resp.Body).Decode(&health); err == nil {
				peers = append(peers, fmt.Sprintf("%s:%d", pa.domain, port))
				pa.activePeers = append(pa.activePeers, port)
				
				// Announce ourselves to this peer
				pa.announceToPeer(port)
			}
		}
	}

	log.Printf("Discovered %d active peers: %v", len(peers), peers)
	return peers
}

// announceToPeer notifies a peer of our existence
func (pa *PortAllocator) announceToPeer(peerPort int) {
	url := fmt.Sprintf("http://%s:%d/peer_announce", pa.domain, peerPort)
	announcement := PeerAnnouncement{
		NodeID:    pa.nodeID,
		HTTPPort:  pa.httpPort,
		Timestamp: time.Now(),
	}

	data, _ := json.Marshal(announcement)
	client := &http.Client{Timeout: 2 * time.Second}
	
	resp, err := client.Post(url, "application/json", strings.NewReader(string(data)))
	if err != nil {
		log.Printf("Failed to announce to peer at port %d: %v", peerPort, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		log.Printf("Successfully announced to peer at port %d", peerPort)
	}
}

// GetActivePeers returns the list of currently active peer ports
func (pa *PortAllocator) GetActivePeers() []int {
	pa.mu.RLock()
	defer pa.mu.RUnlock()
	
	result := make([]int, len(pa.activePeers))
	copy(result, pa.activePeers)
	return result
}

// AddPeer adds a newly discovered peer
func (pa *PortAllocator) AddPeer(port int) {
	pa.mu.Lock()
	defer pa.mu.Unlock()
	
	// Check if peer already exists
	for _, p := range pa.activePeers {
		if p == port {
			return
		}
	}
	
	pa.activePeers = append(pa.activePeers, port)
	log.Printf("Added new peer at port %d, total peers: %d", port, len(pa.activePeers))
}

// RemovePeer removes a departing peer
func (pa *PortAllocator) RemovePeer(port int) {
	pa.mu.Lock()
	defer pa.mu.Unlock()
	
	newPeers := make([]int, 0, len(pa.activePeers))
	for _, p := range pa.activePeers {
		if p != port {
			newPeers = append(newPeers, p)
		}
	}
	
	pa.activePeers = newPeers
	log.Printf("Removed peer at port %d, remaining peers: %d", port, len(pa.activePeers))
}

// NotifyShutdown informs all peers that this node is leaving
func (pa *PortAllocator) NotifyShutdown() {
	departure := PeerDeparture{
		NodeID:   pa.nodeID,
		HTTPPort: pa.httpPort,
		Reason:   "planned_shutdown",
	}

	data, _ := json.Marshal(departure)
	
	for _, peerPort := range pa.GetActivePeers() {
		url := fmt.Sprintf("http://%s:%d/peer_leaving", pa.domain, peerPort)
		client := &http.Client{Timeout: 2 * time.Second}
		
		resp, err := client.Post(url, "application/json", strings.NewReader(string(data)))
		if err != nil {
			log.Printf("Failed to notify peer at port %d of shutdown: %v", peerPort, err)
			continue
		}
		resp.Body.Close()
	}

	log.Printf("Notified %d peers of shutdown", len(pa.activePeers))
}

// Cleanup releases resources
func (pa *PortAllocator) Cleanup() {
	pa.releasePort()
}