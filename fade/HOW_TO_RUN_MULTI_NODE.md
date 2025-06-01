# How to Run REPRAM Fade Multi-Node Test

This guide walks you through running a multi-node REPRAM setup using Docker Compose to test distributed ephemeral storage with the Fade demo.

## Prerequisites

- Docker and Docker Compose installed
- Web browser (Chrome/Firefox recommended)  
- Ports 3000, 3010, 3020, 8080-8082, and 9090-9092 available

## Quick Start (5 minutes)

### Step 1: Start the Multi-Node Cluster

```bash
cd fade
docker-compose -f docker-compose-flux-test.yml up
```

This starts:
- **3 cluster nodes** with gossip replication (ports 8080-8082)
- **3 fade servers** for load balancing (ports 3000, 3010, 3020)

You'll see output like:
```
✓ Node 1 started successfully (healthy)
✓ Node 2 started and bootstrapped successfully (healthy)  
✓ Node 3 started and bootstrapped successfully (healthy)
✓ Fade servers started successfully (healthy)
```

### Step 2: Access the Fade UI

Open your browser to any of these URLs:
- **http://localhost:3000** (Fade server 1)
- **http://localhost:3010** (Fade server 2) 
- **http://localhost:3020** (Fade server 3)

All fade servers show the same data thanks to gossip replication!

### Step 3: Test Gossip Replication

#### Test 1: Cross-Server Consistency

1. **Open 3 browser windows**:
   - Window 1: http://localhost:3000
   - Window 2: http://localhost:3010  
   - Window 3: http://localhost:3020

2. **Send a message** in Window 1: "Hello from server 1"

3. **Verify replication**: The message appears in Windows 2 and 3 within 1-3 seconds

4. **Key insight**: All fade servers access the same replicated data

#### Test 2: Node-Level Replication

1. **Direct node access** - verify all cluster nodes have the data:
   ```bash
   # Check each cluster node directly
   curl http://localhost:8080/data/test-key
   curl http://localhost:8081/data/test-key  
   curl http://localhost:8082/data/test-key
   ```

2. **All nodes return the same data** - proving gossip replication works

## Architecture Overview

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Browser :3000│  │ Browser :3010│  │ Browser :3020│
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│ Fade Server │  │ Fade Server │  │ Fade Server │
│   :3000     │  │   :3010     │  │   :3020     │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
       ┌────────────────┼────────────────┐
       │                │                │
┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│ Cluster     │◄─┤ Cluster     │◄─┤ Cluster     │
│ Node :8080  │  │ Node :8081  │  │ Node :8082  │
│ Gossip:9090 │  │ Gossip:9091 │  │ Gossip:9092 │
└─────────────┘  └─────────────┘  └─────────────┘
       ▲                │                ▲
       └────────────────┼────────────────┘
                        │
                 Gossip Replication
```

### Key Features

- **Multiple Fade Servers**: Simulates Flux deployment with 3+ instances
- **Gossip Replication**: Messages automatically replicate across all cluster nodes
- **Load Balancing**: Each fade server can handle user requests independently
- **Fault Tolerance**: System continues working if individual components fail
- **Consistent Data**: All users see the same messages regardless of entry point

## Advanced Testing

### Monitor Cluster Health

In a new terminal, use the monitoring scripts:

```bash
# Real-time cluster health monitoring
./monitor-health.sh

# Real-time gossip protocol monitoring  
./monitor-gossip.sh
```

### Test Fault Tolerance

1. **Stop a cluster node**:
   ```bash
   docker-compose -f docker-compose-flux-test.yml stop fade-node-2
   ```

2. **Continue using the UI** - messages still work with remaining nodes

3. **Restart the node**:
   ```bash
   docker-compose -f docker-compose-flux-test.yml start fade-node-2
   ```

4. **Verify recovery** - the node rejoins and syncs data

### Test Fade Server Failover

1. **Stop a fade server**:
   ```bash
   docker-compose -f docker-compose-flux-test.yml stop fade-web-2
   ```

2. **Users on port 3010** would be redirected by load balancer in production

3. **Other fade servers continue working** on ports 3000 and 3020

### Performance Testing

```bash
# Send multiple messages to test load distribution
for i in {1..10}; do
  curl -X PUT "http://localhost:3000/api/data/test-$i?ttl=300" \
    -d "Test message $i" -H "Content-Type: text/plain"
done

# Verify all messages replicated to all nodes
curl http://localhost:8080/scan | jq .
curl http://localhost:8081/scan | jq .  
curl http://localhost:8082/scan | jq .
```

## Alternative: Simple Testing Setup

For basic testing without multiple fade servers:

```bash
# Use the simpler docker-compose setup
docker-compose up
```

This runs the original configuration for basic development.

## Stopping the Cluster

```bash
# Stop everything and clean up
docker-compose -f docker-compose-flux-test.yml down

# With volume cleanup (removes any persistent data)
docker-compose -f docker-compose-flux-test.yml down -v
```

## Troubleshooting

### Port Conflicts
```bash
# Check what's using a port
lsof -i :3000

# Stop conflicting processes
docker-compose -f docker-compose-flux-test.yml down
```

### Container Health Issues
```bash
# Check container status
docker-compose -f docker-compose-flux-test.yml ps

# View logs for specific service
docker-compose -f docker-compose-flux-test.yml logs fade-web-1
docker-compose -f docker-compose-flux-test.yml logs fade-node-1
```

### Gossip Not Working
```bash
# Check cluster node logs for bootstrap issues
docker-compose -f docker-compose-flux-test.yml logs fade-node-2
docker-compose -f docker-compose-flux-test.yml logs fade-node-3

# Verify nodes can reach each other
docker-compose -f docker-compose-flux-test.yml exec fade-node-1 wget -qO- fade-node-2:8080/health
```

## Next Steps

1. **Deploy to Production**: Use the same container architecture on Flux
2. **Test Load Balancing**: Deploy behind a real load balancer  
3. **Scale Testing**: Add more cluster nodes and fade servers
4. **Geographic Distribution**: Deploy nodes across multiple regions

## Key Insights

### Why This Architecture Works for Flux

- **Flux Requirement**: Minimum 3 replicas per service
- **Solution**: 3 fade servers + 3 cluster nodes
- **Result**: Users get consistent experience regardless of which fade server they hit
- **Reliability**: Gossip protocol ensures data consistency across all nodes

### Tested Scenarios

✅ **Multi-fade-server access** - All servers show same data  
✅ **Gossip replication** - Messages appear on all cluster nodes  
✅ **Load balancing** - Multiple entry points work correctly  
✅ **Fault tolerance** - System survives individual component failures  

This configuration exactly matches what will run in production on Flux!