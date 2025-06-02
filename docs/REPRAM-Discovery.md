# REPRAM Distributed Port Allocation & Service Discovery

## Overview

This document describes a self-organizing port allocation and service discovery mechanism for deploying REPRAM as a distributed application on the Flux network. The system enables multiple REPRAM instances to automatically discover available ports, establish their network identity, and form a peer-to-peer gossip network without external coordination.

## Core Concept

Each REPRAM instance uses a **single port** for all communication (gossip, API, health checks). Instances automatically allocate ports in sequential order through a distributed consensus mechanism, creating a self-organizing network topology.

## Architecture

### Port Allocation Strategy

```json
{
  "application_name": "fade-repram",
  "domain": "fade.repram.io", 
  "container_ports": [8081, 8082, 8083, 8084, 8085],
  "instances": 5
}
```

### Node Identity Mapping
- **Node 1**: `fade.repram.io:8081`
- **Node 2**: `fade.repram.io:8082`
- **Node 3**: `fade.repram.io:8083`
- **Node N**: `fade.repram.io:808N`

## Implementation Algorithm

### 1. Port Discovery & Allocation

```pseudocode
function allocate_port():
    predefined_ports = [8081, 8082, 8083, 8084, 8085]
    
    for port in predefined_ports:
        try:
            # Attempt to bind to the port
            socket = bind_socket(port)
            
            # Double-check port isn't responding to HTTP
            if not http_probe("fade.repram.io:" + port + "/health"):
                my_port = port
                start_server(socket, port)
                log("Claimed port: " + port)
                return port
            else:
                close_socket(socket)
                
        except PortAlreadyBound:
            continue
            
    throw "No available ports found"
```

### 2. Peer Discovery Protocol

```pseudocode
function discover_peers():
    known_ports = [8081, 8082, 8083, 8084, 8085]
    active_peers = []
    
    for port in known_ports:
        if port == my_port:
            continue
            
        try:
            response = http_get("fade.repram.io:" + port + "/health")
            if response.status == 200:
                active_peers.append(port)
                # Announce self to discovered peer
                http_post("fade.repram.io:" + port + "/peer_announce", {
                    "new_peer_port": my_port,
                    "timestamp": current_time()
                })
        except NetworkError:
            # Port not responding, likely no node there
            continue
    
    return active_peers
```

### 3. Network Formation Timeline

**Startup Sequence:**

1. **Node A starts first**
   - Probes 8081 → no response
   - Binds to 8081, starts HTTP server
   - Becomes `fade.repram.io:8081`

2. **Node B starts second**
   - Probes 8081 → gets response from Node A
   - Probes 8082 → no response
   - Binds to 8082, starts HTTP server
   - Announces to Node A: "I'm now at 8082"
   - Becomes `fade.repram.io:8082`

3. **Node C starts third**
   - Probes 8081 → Node A responds
   - Probes 8082 → Node B responds  
   - Probes 8083 → no response
   - Binds to 8083, starts HTTP server
   - Announces to Node A and B: "I'm now at 8083"

## Protocol Specification

### HTTP API Endpoints

Each node exposes a standard REST API on its allocated port:

```
GET  /health
     Response: {"status": "healthy", "port": 8081, "uptime": 3600}

GET  /peers  
     Response: {"peers": [8082, 8083], "last_updated": "2025-01-15T10:30:00Z"}

POST /peer_announce
     Payload: {"new_peer_port": 8084, "timestamp": "2025-01-15T10:35:00Z"}
     Response: {"acknowledged": true}

POST /gossip
     Payload: <REPRAM gossip protocol data>
     Response: <REPRAM response>

POST /peer_leaving
     Payload: {"departing_port": 8082, "reason": "shutdown"}
     Response: {"acknowledged": true}
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
    while running:
        for peer_port in active_peers:
            try:
                response = http_get("fade.repram.io:" + peer_port + "/health", timeout=5)
                if response.status != 200:
                    handle_peer_failure(peer_port)
            except Timeout:
                handle_peer_failure(peer_port)
        
        sleep(30)  # Health check every 30 seconds

function handle_peer_failure(failed_port):
    active_peers.remove(failed_port)
    log("Peer at port " + failed_port + " is unreachable")
    # REPRAM gossip protocol handles data rebalancing
```

### Graceful Shutdown

```pseudocode
function shutdown_gracefully():
    # Notify all peers this node is leaving
    for peer_port in active_peers:
        http_post("fade.repram.io:" + peer_port + "/peer_leaving", {
            "departing_port": my_port,
            "reason": "planned_shutdown"
        })
    
    # Allow time for gossip protocol to redistribute data
    sleep(10)
    
    # Close server
    stop_server()
```

### Node Recovery

When a failed node restarts:

1. **Port Reclamation**: Attempts to bind to its previous port
2. **State Recovery**: Uses REPRAM's gossip protocol to rebuild state
3. **Peer Reconnection**: Re-announces to all active peers

## Network Topology

### Star-like Discovery, Mesh Communication

```
    fade.repram.io:8081 ←→ fade.repram.io:8082
           ↕                     ↕
    fade.repram.io:8085 ←→ fade.repram.io:8083
           ↕                     ↕  
         fade.repram.io:8084
```

- **Discovery**: Sequential port probing creates natural ordering
- **Communication**: Full mesh for gossip protocol efficiency
- **Addressing**: Each node has a stable, predictable address

## Scaling Operations

### Adding Nodes

```bash
# Update Flux application configuration
{
  "container_ports": [8081, 8082, 8083, 8084, 8085, 8086],
  "instances": 6
}

# New node automatically:
# 1. Discovers ports 8081-8085 are taken
# 2. Claims port 8086
# 3. Announces to existing network
# 4. Integrates via REPRAM gossip protocol
```

### Removing Nodes

```bash
# Scale down Flux application
{
  "instances": 4  # One node will be terminated
}

# Terminated node:
# 1. Receives shutdown signal
# 2. Notifies peers it's leaving
# 3. REPRAM redistributes its data
# 4. Port becomes available for future use
```

## External Integration

### Monitoring & Observability

```bash
# Health check all nodes
for port in 8081 8082 8083; do
  curl fade.repram.io:$port/health
done

# Get network topology
curl fade.repram.io:8081/peers

# Check REPRAM application status
curl fade.repram.io:8082/status
```

### Load Balancing

External systems can:
- **Round-robin** requests across all active ports
- **Health-check** ports before routing traffic
- **Auto-discover** active nodes via port scanning

### Development & Debugging

```bash
# Connect to specific node
curl fade.repram.io:8081/api/query

# Submit data to any node (gossip will replicate)
curl -X POST fade.repram.io:8082/api/submit -d "data"

# Monitor peer relationships
curl fade.repram.io:8083/peers
```

## Security Considerations

### Port Scanning Protection
- Rate limiting on discovery endpoints
- Authentication for administrative operations
- Logging of peer announcements

### Network Segmentation
- All communication over HTTPS in production
- Firewall rules limiting port range access
- VPN requirements for administrative access

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