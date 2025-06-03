# REPRAM Distributed Port Allocation & Service Discovery

## Overview

This document describes a self-organizing port allocation and service discovery mechanism for deploying REPRAM as a distributed application on the Flux network. The system enables multiple REPRAM instances to automatically discover available ports, establish their network identity, and form a peer-to-peer gossip network without external coordination.

## Core Concept

Each REPRAM instance uses a **single port** for all communication (gossip, API, health checks). Instances automatically allocate ports in sequential order through a distributed consensus mechanism, creating a self-organizing network topology.

## Architecture

### Configuration via Environment Variables

```bash
# Required environment variables
REPRAM_DOMAIN="fade.repram.io"           # Base domain for the application
REPRAM_START_PORT=8081                   # First port to try
REPRAM_MAX_INSTANCES=10                  # Maximum number of nodes
REPRAM_PORT_RETRY_DELAY=5                # Seconds to wait before retrying allocation
REPRAM_HEALTH_CHECK_INTERVAL=30          # Seconds between peer health checks
```

### Dynamic Port Allocation Strategy

```json
{
  "application_name": "fade-repram",
  "container_ports": [8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090],
  "instances": 5,
  "environment": {
    "REPRAM_DOMAIN": "fade.repram.io",
    "REPRAM_START_PORT": "8081",
    "REPRAM_MAX_INSTANCES": "10"
  }
}
```

### Dynamic Node Identity Mapping
- **Node 1**: `${REPRAM_DOMAIN}:${REPRAM_START_PORT}`
- **Node 2**: `${REPRAM_DOMAIN}:${REPRAM_START_PORT + 1}`
- **Node 3**: `${REPRAM_DOMAIN}:${REPRAM_START_PORT + 2}`
- **Node N**: `${REPRAM_DOMAIN}:${REPRAM_START_PORT + (N-1)}`

## Implementation Algorithm

### 1. Port Discovery & Allocation with Race Condition Handling

```pseudocode
function allocate_port():
    domain = env("REPRAM_DOMAIN")
    start_port = int(env("REPRAM_START_PORT"))
    max_instances = int(env("REPRAM_MAX_INSTANCES"))
    retry_delay = int(env("REPRAM_PORT_RETRY_DELAY", "5"))
    
    port_range = [start_port + i for i in range(max_instances)]
    my_uuid = generate_uuid()  # Unique identifier for this instance
    
    while true:
        allocated_port = attempt_port_allocation(port_range, domain, my_uuid)
        if allocated_port:
            return allocated_port
        
        log("No ports available, waiting " + retry_delay + " seconds...")
        sleep(retry_delay)

function attempt_port_allocation(port_range, domain, my_uuid):
    for port in port_range:
        try:
            # Step 1: Try to bind to the port
            socket = bind_socket(port)
            
            # Step 2: Start HTTP server immediately
            start_server(socket, port)
            
            # Step 3: Check for conflicts with other nodes
            sleep(random(1, 3))  # Random delay to reduce collision probability
            
            conflict_detected = check_port_conflict(domain, port, my_uuid)
            if conflict_detected:
                log("Port conflict detected on " + port + ", releasing...")
                stop_server()
                close_socket(socket)
                continue
            
            # Step 4: Successfully claimed the port
            my_port = port
            log("Successfully claimed port: " + port)
            return port
            
        except PortAlreadyBound:
            log("Port " + port + " already bound, trying next...")
            continue
    
    return null  # No ports available

function check_port_conflict(domain, port, my_uuid):
    try:
        # Query our own health endpoint
        response = http_get(domain + ":" + port + "/health")
        
        if response.uuid != my_uuid:
            # Another node is responding on this port - conflict!
            return true
        
        # Also check if multiple nodes claim the same port
        peer_responses = []
        for peer_port in get_potential_peer_ports():
            if peer_port == port:
                continue
            try:
                peer_response = http_get(domain + ":" + peer_port + "/peers")
                if port in peer_response.claimed_ports:
                    peer_responses.append(peer_response.uuid)
            except:
                continue
        
        # If multiple peers think they own this port, resolve conflict
        if len(peer_responses) > 0:
            # Use UUID comparison for deterministic conflict resolution
            for peer_uuid in peer_responses:
                if my_uuid > peer_uuid:  # Lexicographic comparison
                    return true  # This node should yield
        
        return false
        
    except NetworkError:
        # Can't reach the port, probably safe to claim
        return false
```

### 2. Peer Discovery Protocol

```pseudocode
function discover_peers():
    domain = env("REPRAM_DOMAIN")
    start_port = int(env("REPRAM_START_PORT"))
    max_instances = int(env("REPRAM_MAX_INSTANCES"))
    
    potential_ports = [start_port + i for i in range(max_instances)]
    active_peers = []
    
    for port in potential_ports:
        if port == my_port:
            continue
            
        try:
            response = http_get(domain + ":" + port + "/health", timeout=5)
            if response.status == 200:
                active_peers.append({
                    "port": port,
                    "uuid": response.uuid,
                    "last_seen": current_time()
                })
                
                # Announce self to discovered peer
                http_post(domain + ":" + port + "/peer_announce", {
                    "new_peer_port": my_port,
                    "new_peer_uuid": my_uuid,
                    "timestamp": current_time()
                })
        except NetworkError:
            # Port not responding, likely no node there
            continue
    
    return active_peers
```

### 3. Network Formation Timeline

**Startup Sequence with Race Condition Handling:**

1. **Node A starts first**
   - Reads `REPRAM_DOMAIN=fade.repram.io`, `REPRAM_START_PORT=8081`
   - Generates UUID: `a1b2c3d4`
   - Probes 8081 → no response, binds successfully
   - Waits random delay (1-3s), checks for conflicts
   - No conflicts detected, claims `fade.repram.io:8081`

2. **Node B starts simultaneously**
   - Generates UUID: `e5f6g7h8` 
   - Also tries 8081 → port already bound
   - Tries 8082 → binds successfully
   - Waits random delay, checks for conflicts
   - Claims `fade.repram.io:8082`

3. **Node C and D start at exactly the same time**
   - Both generate UUIDs: `i9j0k1l2` and `m3n4o5p6`
   - Both find 8081, 8082 occupied
   - **Both try 8083 simultaneously**
   - Both might bind successfully due to timing
   - After random delay:
     - Node C (UUID `i9j0k1l2`) checks health endpoint
     - Node D (UUID `m3n4o5p6`) also responds on 8083
     - Conflict detected! UUID comparison: `i9j0k1l2` < `m3n4o5p6`
     - Node D yields (higher UUID), releases 8083
     - Node D tries 8084, succeeds
   - Final: Node C on 8083, Node D on 8084

4. **Node E starts later**
   - Discovers active peers at 8081, 8082, 8083, 8084
   - Claims 8085
   - Announces to all existing peers

## Protocol Specification

### HTTP API Endpoints

Each node exposes a standard REST API on its allocated port:

```
GET  /health
     Response: {
       "status": "healthy", 
       "port": 8081, 
       "uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
       "uptime": 3600,
       "domain": "fade.repram.io"
     }

GET  /peers  
     Response: {
       "peers": [
         {"port": 8082, "uuid": "e5f6g7h8", "last_seen": "2025-01-15T10:30:00Z"},
         {"port": 8083, "uuid": "i9j0k1l2", "last_seen": "2025-01-15T10:29:45Z"}
       ],
       "claimed_ports": [8081],
       "last_updated": "2025-01-15T10:30:00Z"
     }

POST /peer_announce
     Payload: {
       "new_peer_port": 8084, 
       "new_peer_uuid": "m3n4o5p6",
       "timestamp": "2025-01-15T10:35:00Z"
     }
     Response: {"acknowledged": true, "my_uuid": "a1b2c3d4"}

POST /gossip
     Payload: <REPRAM gossip protocol data>
     Response: <REPRAM response>

POST /peer_leaving
     Payload: {
       "departing_port": 8082, 
       "departing_uuid": "e5f6g7h8",
       "reason": "shutdown"
     }
     Response: {"acknowledged": true}

POST /conflict_resolution
     Payload: {
       "conflicting_port": 8083,
       "my_uuid": "i9j0k1l2",
       "timestamp": "2025-01-15T10:36:00Z"
     }
     Response: {
       "should_yield": false,  // false means you can keep the port
       "peer_uuid": "a1b2c3d4"
     }
```

### REPRAM Application API

```
GET  /status
     Response: REPRAM node status and metrics

POST /api/submit
     Payload: Application-specific data
     Response: Processing result

GET  /api/query
     Response: Current REPRAM state
```

## Fault Tolerance & Recovery

### Node Failure Detection

```pseudocode
function monitor_peers():
    health_check_interval = int(env("REPRAM_HEALTH_CHECK_INTERVAL", "30"))
    domain = env("REPRAM_DOMAIN")
    
    while running:
        failed_peers = []
        
        for peer in active_peers:
            try:
                response = http_get(domain + ":" + peer.port + "/health", timeout=5)
                if response.status != 200 or response.uuid != peer.uuid:
                    failed_peers.append(peer)
                else:
                    peer.last_seen = current_time()
                    
            except Timeout:
                failed_peers.append(peer)
        
        for failed_peer in failed_peers:
            handle_peer_failure(failed_peer)
        
        sleep(health_check_interval)

function handle_peer_failure(failed_peer):
    active_peers.remove(failed_peer)
    log("Peer at port " + failed_peer.port + " (UUID: " + failed_peer.uuid + ") is unreachable")
    # REPRAM gossip protocol handles data rebalancing
```

### Graceful Shutdown

```pseudocode
function shutdown_gracefully():
    domain = env("REPRAM_DOMAIN")
    
    # Notify all peers this node is leaving
    for peer in active_peers:
        http_post(domain + ":" + peer.port + "/peer_leaving", {
            "departing_port": my_port,
            "departing_uuid": my_uuid,
            "reason": "planned_shutdown"
        })
    
    # Allow time for gossip protocol to redistribute data
    sleep(10)
    
    # Close server
    stop_server()
```

### Node Recovery

When a failed node restarts:

1. **Port Reclamation**: Attempts to bind to its previous port (if stored in persistent config)
2. **Conflict Detection**: Checks if another node claimed its previous port
3. **State Recovery**: Uses REPRAM's gossip protocol to rebuild state
4. **Peer Reconnection**: Re-announces to all active peers with new or recovered UUID

```pseudocode
function recover_from_restart():
    previous_port = load_from_persistent_storage("my_port")
    previous_uuid = load_from_persistent_storage("my_uuid") 
    
    if previous_port and previous_uuid:
        # Try to reclaim previous identity
        if attempt_port_reclaim(previous_port, previous_uuid):
            return previous_port
    
    # Fall back to normal allocation
    return allocate_port()

function attempt_port_reclaim(port, uuid):
    try:
        socket = bind_socket(port)
        my_port = port
        my_uuid = uuid
        start_server(socket, port)
        return true
    except PortAlreadyBound:
        log("Previous port " + port + " now occupied, will allocate new port")
        return false
```

## Network Topology

### Star-like Discovery, Mesh Communication

```
${REPRAM_DOMAIN}:${START_PORT} ←→ ${REPRAM_DOMAIN}:${START_PORT+1}
           ↕                              ↕
${REPRAM_DOMAIN}:${START_PORT+4} ←→ ${REPRAM_DOMAIN}:${START_PORT+2}
           ↕                              ↕  
         ${REPRAM_DOMAIN}:${START_PORT+3}
```

- **Discovery**: Sequential port probing creates natural ordering
- **Communication**: Full mesh for gossip protocol efficiency  
- **Addressing**: Each node has a stable, predictable address
- **Flexibility**: Domain and port range configurable via environment

## Scaling Operations

### Adding Nodes

```bash
# Update Flux application configuration
{
  "container_ports": [8081, 8082, 8083, 8084, 8085, 8086],
  "instances": 6,
  "environment": {
    "REPRAM_DOMAIN": "fade.repram.io",
    "REPRAM_START_PORT": "8081",
    "REPRAM_MAX_INSTANCES": "15"  # Increased to allow more growth
  }
}

# New node automatically:
# 1. Reads environment variables
# 2. Discovers ports 8081-8085 are taken  
# 3. Claims port 8086
# 4. Announces to existing network
# 5. Integrates via REPRAM gossip protocol
```

### Removing Nodes

```bash
# Scale down Flux application
{
  "instances": 4  # One node will be terminated
}

# Terminated node:
# 1. Receives shutdown signal
# 2. Notifies peers it's leaving (with UUID)
# 3. REPRAM redistributes its data
# 4. Port becomes available for future use
```

### Configuration Changes

```bash
# Move to different domain/port range
{
  "environment": {
    "REPRAM_DOMAIN": "production.repram.io", 
    "REPRAM_START_PORT": "9000",
    "REPRAM_MAX_INSTANCES": "20"
  }
}

# Nodes will use production.repram.io:9000, 9001, 9002...
```

## External Integration

### Monitoring & Observability

```bash
# Environment-aware health checking
DOMAIN=$(echo $REPRAM_DOMAIN)
START_PORT=$(echo $REPRAM_START_PORT)

# Health check all nodes dynamically
for i in {0..4}; do
  PORT=$((START_PORT + i))
  curl ${DOMAIN}:${PORT}/health
done

# Get network topology from any node
curl ${DOMAIN}:${START_PORT}/peers

# Check REPRAM application status
curl ${DOMAIN}:$((START_PORT + 1))/status
```

### Load Balancing

External systems can:
- **Environment-aware discovery** via `REPRAM_DOMAIN` and `REPRAM_START_PORT`
- **Dynamic port range scanning** based on `REPRAM_MAX_INSTANCES`
- **UUID-based health checking** to detect port conflicts
- **Automatic failover** when nodes change ports due to conflicts

### Development & Debugging

```bash
# Configuration-based connection
DOMAIN=${REPRAM_DOMAIN:-"localhost"}  
START_PORT=${REPRAM_START_PORT:-8081}

# Connect to specific node
curl ${DOMAIN}:${START_PORT}/api/query

# Submit data to any node (gossip will replicate)  
curl -X POST ${DOMAIN}:$((START_PORT + 1))/api/submit -d "data"

# Monitor peer relationships and conflicts
curl ${DOMAIN}:$((START_PORT + 2))/peers

# Check for port conflicts
curl ${DOMAIN}:${START_PORT}/health | jq .uuid
```

## Security Considerations

### Port Scanning Protection
- Rate limiting on discovery endpoints
- Authentication for administrative operations  
- Logging of peer announcements and conflicts
- UUID validation to prevent spoofing

### Network Segmentation
- All communication over HTTPS in production
- Firewall rules limiting configurable port range access
- VPN requirements for administrative access
- Environment variable validation and sanitization

### Race Condition Security
- Cryptographically secure UUID generation
- Deterministic conflict resolution to prevent split-brain
- Audit logging of all port claim/release events
- Timeout protection against malicious port holding

## Benefits

### 🎯 **Zero Configuration**
- No external service discovery required
- No coordination databases needed  
- Self-organizing network formation

### 🔄 **Automatic Recovery**
- Nodes auto-discover after failures
- Graceful handling of network partitions
- Port reuse after node replacement

### 📈 **Linear Scaling**
- Add nodes by increasing port list
- Predictable addressing scheme
- No single points of failure

### 🛠 **Operational Simplicity**
- Standard HTTP monitoring endpoints
- Clear node identity (port = node)
- Easy debugging and troubleshooting

### 🌐 **Platform Agnostic**
- Works on any container platform
- No Flux-specific dependencies
- Portable across cloud providers

## Conclusion

This port allocation scheme provides a robust, self-organizing foundation for distributed REPRAM deployment on Flux. By combining automatic port discovery with the platform's predictable domain naming, we achieve both operational simplicity and technical elegance. The system requires no external dependencies while providing full fault tolerance and linear scalability.