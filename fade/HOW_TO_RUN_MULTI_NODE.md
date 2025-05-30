# How to Run REPRAM Fade Multi-Node Test

This guide walks you through running a multi-node REPRAM setup to test distributed ephemeral storage and see the Fade demo working across multiple nodes.

## Prerequisites

- Go 1.22+ installed
- Terminal access
- Web browser (Chrome/Firefox recommended)
- Ports 8080-8082 and 3000 available

## Multi-Node Testing Options

REPRAM Fade supports two types of multi-node setups:

1. **Simple Multi-Node**: Independent nodes (no replication) - Good for testing load balancing
2. **Gossip-Enabled Cluster**: Real distributed replication - Good for testing full REPRAM behavior

## Option 1: Quick Start - Simple Multi-Node (5 minutes)

### Step 1: Build the Project

```bash
cd /path/to/REPRAM
make build-raw
```

### Step 2: Start the Simple Multi-Node Cluster

```bash
cd fade
./start-simple-multi-node.sh
```

The script will now verify each node starts successfully:
```
Starting raw nodes...
Starting raw node 1 on port 8080...
✓ Node 1 started successfully
Starting raw node 2 on port 8081...
✓ Node 2 started successfully
Starting raw node 3 on port 8082...
✓ Node 3 started successfully

Verifying all nodes are healthy...
✓ Raw node on port 8080 is healthy
✓ Raw node on port 8081 is healthy
✓ Raw node on port 8082 is healthy

✓ Simple multi-node Fade setup is ready!

URLs:
  - Fade UI: http://localhost:3000
  - Raw Node 1: http://localhost:8080
  - Raw Node 2: http://localhost:8081
  - Raw Node 3: http://localhost:8082
```

### Step 3: Open Multiple Browser Windows

1. Open **2-3 browser windows** or tabs
2. Navigate each to **http://localhost:3000**
3. You'll see the Fade ephemeral message board

### Step 4: Test Multi-Node Behavior

#### Test 1: Basic Message Distribution
1. In Window 1: Send a message "Hello from window 1"
2. In Window 2: Watch it appear (within 3 seconds)
3. Notice the message key - each node generates unique keys

#### Test 2: Load Balancing
1. Send multiple messages rapidly
2. Check the browser console (F12) to see which node responds
3. The proxy server distributes requests across nodes

#### Test 3: Node Isolation
1. Send a message and copy its key
2. Check each node directly:
   ```bash
   # Replace MSG_KEY with your actual message key
   curl http://localhost:8080/raw/get/MSG_KEY
   curl http://localhost:8081/raw/get/MSG_KEY
   curl http://localhost:8082/raw/get/MSG_KEY
   ```
3. Only one node will have the message (no gossip in simple mode)

### Step 5: Test Node Failure

1. Stop one node:
   ```bash
   # Find and kill node 2
   lsof -i :8081 | grep repram | awk '{print $2}' | xargs kill
   ```

2. Continue using the UI - it automatically failovers to healthy nodes

3. Verify node is down:
   ```bash
   curl http://localhost:8081/health
   # Should fail
   ```

4. The UI continues working with remaining nodes!

## Option 2: Gossip-Enabled Cluster (Recommended for Full Testing)

### Step 1: Build Cluster Components

```bash
cd /path/to/REPRAM
go build -o bin/repram-fade-cluster ./cmd/fade-cluster-node
```

### Step 2: Start the Gossip Cluster

```bash
cd fade
./start-gossip-multi-node.sh
```

You'll see output like:
```
Starting REPRAM Fade multi-node setup with GOSSIP replication...
This uses cluster nodes that replicate data between each other

Starting cluster node 1 on port 8080 (seed node)...
✓ Node 1 started successfully
Starting cluster node 2 on port 8081 (bootstrapping from node 1)...
✓ Node 2 started and bootstrapped successfully
Starting cluster node 3 on port 8082 (bootstrapping from node 1)...
✓ Node 3 started and bootstrapped successfully

Waiting for bootstrap and gossip protocol to establish connections...

✓ Multi-node Fade setup with GOSSIP is ready!

URLs:
  - Fade UI: http://localhost:3000
  - Cluster Node 1: http://localhost:8080 (gossip port: 7080)
  - Cluster Node 2: http://localhost:8081 (gossip port: 7081)
  - Cluster Node 3: http://localhost:8082 (gossip port: 7082)
```

### Step 2a: Monitor Cluster Health (Optional)

In a new terminal, monitor the health of all nodes:
```bash
./monitor-health.sh
```

This shows:
- Real-time node status (✓ healthy, ✗ down)
- Process information and PIDs
- Automatic replication tests every 5 seconds
- Web server status

### Step 2b: Monitor Gossip Activity (Optional)

In another terminal, watch gossip messages in real-time:
```bash
./monitor-gossip.sh
```

This displays:
- Color-coded gossip messages from all nodes
- Bootstrap events and peer discovery
- PUT broadcasts and ACK acknowledgments
- SYNC messages for topology updates
- PING/PONG health checks

### Step 3: Test Gossip Replication

#### Test 1: Message Replication Across Nodes

1. **Open 2 browser windows** to http://localhost:3000

2. **Window 1 - Send to Node 1**:
   - Select "Node 1 (8080)" in the node selector
   - Send message: "Hello from Node 1"
   - Note the message shows `[node-1]` indicator

3. **Window 2 - Check Node 2**:
   - Select "Node 2 (8081)" in the node selector
   - The message should appear within 1-3 seconds
   - It will show `[node-1]` indicator (showing original source)

4. **Verify Full Replication**:
   - Select "Node 3 (8082)" in either window
   - The same message should appear here too with `[node-1]` indicator
   - Use `./monitor-gossip.sh` to see the replication happening in real-time

#### Test 2: Node Source Tracking

1. Send messages from different nodes:
   ```
   Node 1: "Message from first node"  → Shows [node-1]
   Node 2: "Message from second node" → Shows [node-2]
   Node 3: "Message from third node"  → Shows [node-3]
   ```

2. **Verify all messages appear on all nodes** with correct source indicators

3. **Key insight**: Each message retains its original node indicator even after replication

#### Test 3: Real-Time Gossip Monitoring

Use the monitoring scripts to observe the cluster:

1. **Health Monitor** (in a new terminal):
   ```bash
   ./monitor-health.sh
   ```
   Shows node status and runs automatic replication tests every 5 seconds.

2. **Gossip Monitor** (in another terminal):
   ```bash
   ./monitor-gossip.sh
   ```
   Shows color-coded gossip messages:
   - Yellow `[PUT-BROADCAST]` when a node sends data
   - Green `[PUT-RECEIVED]` when nodes receive replicated data
   - Cyan `[ACK-SEND]` for acknowledgments
   - Blue `[SYNC]` for peer discovery

3. **Manual Log Inspection**:
   ```bash
   # Watch raw logs if needed
   tail -f cluster-node*.log | grep -E "Broadcasting|Received|SYNC"
   ```

### Step 4: Test Network Partition Tolerance

1. **Stop Node 2**:
   ```bash
   kill $(lsof -ti:8081)
   ```

2. **Continue sending messages** on Nodes 1 and 3
   - Messages should still replicate between active nodes
   - Node selector shows Node 2 as unhealthy

3. **Restart Node 2**:
   ```bash
   # The cluster will auto-restart Node 2 or you can restart manually
   ./start-gossip-multi-node.sh
   ```

4. **Verify catchup**: Node 2 should sync with the cluster

### Stopping Gossip Cluster

```bash
./stop-gossip-multi-node.sh
```

### Understanding Gossip Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Browser 1  │     │  Browser 2  │     │  Browser 3  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                           │
                    ┌──────▼──────┐
                    │ Fade Proxy  │
                    │  Port 3000  │ (Node Preference Routing)
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
│ Cluster 1   │◄───►│ Cluster 2   │◄───►│ Cluster 3   │
│ HTTP: 8080  │     │ HTTP: 8081  │     │ HTTP: 8082  │
│ Gossip:7080 │     │ Gossip:7081 │     │ Gossip:7082 │
└─────────────┘     └─────────────┘     └─────────────┘
       ▲                   ▲                   ▲
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    Full Mesh Gossip
```

**Key Differences from Simple Multi-Node**:
- ✅ **Data replication**: Messages appear on all nodes within 1-3 seconds
- ✅ **Source tracking**: Original node is preserved with indicators
- ✅ **Bootstrap protocol**: Initial peer discovery via HTTP endpoints
- ✅ **Gossip protocol**: Real-time data replication between peers
- ✅ **Fault tolerance**: Quorum-based writes (2/3 nodes must acknowledge)
- ✅ **Full mesh**: Nodes discover each other via bootstrap, then maintain connections

## Advanced Testing

### Monitor Node Activity

Watch logs in real-time:
```bash
# In separate terminals:
tail -f raw-node1.log
tail -f raw-node2.log  
tail -f raw-node3.log
tail -f web.log
```

### Direct Node Testing

```bash
# Store on specific nodes
curl -X POST http://localhost:8080/raw/put \
  -H "Content-Type: application/json" \
  -d '{"data":"Node 1 exclusive message","ttl":300}'

curl -X POST http://localhost:8081/raw/put \
  -H "Content-Type: application/json" \
  -d '{"data":"Node 2 exclusive message","ttl":300}'

# Scan each node's contents
curl http://localhost:8080/raw/scan | jq .
curl http://localhost:8081/raw/scan | jq .
curl http://localhost:8082/raw/scan | jq .
```

### Performance Testing

```bash
# Send 100 messages across nodes
for i in {1..100}; do
  curl -s -X POST http://localhost:3000/api/raw/put \
    -H "Content-Type: application/json" \
    -d "{\"data\":\"Test message $i\",\"ttl\":60}" &
done
wait

# Check distribution
echo "Node 1 messages: $(curl -s http://localhost:8080/raw/scan | jq '.count')"
echo "Node 2 messages: $(curl -s http://localhost:8081/raw/scan | jq '.count')"
echo "Node 3 messages: $(curl -s http://localhost:8082/raw/scan | jq '.count')"
```

## Understanding the Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Browser 1  │     │  Browser 2  │     │  Browser 3  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                           │
                    ┌──────▼──────┐
                    │ Fade Proxy  │
                    │  Port 3000  │
                    └──────┬──────┘
                           │ Load Balances
       ┌───────────────────┼───────────────────┐
       │                   │                   │
┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
│   Node 1    │     │   Node 2    │     │   Node 3    │
│  Port 8080  │     │  Port 8081  │     │  Port 8082  │
└─────────────┘     └─────────────┘     └─────────────┘
```

## Stopping the Cluster

```bash
./stop-simple-multi-node.sh

# With log cleanup
./stop-simple-multi-node.sh --clean
```

## Troubleshooting

### If Nodes Fail to Start

The improved script will now show you exactly what went wrong:
- **Build failures**: Script exits if build fails
- **Port conflicts**: Shows which node failed and displays log tail
- **Health check failures**: Automatically cleans up and exits

If you see an error like:
```
❌ Node 2 failed to start. Check raw-node2.log for details
2025/05/29 18:16:35 listen tcp :8080: bind: address already in use
```

This means the node wasn't using the correct port. The script now uses environment variables correctly.

### Port Already in Use
```bash
# Find what's using the port
lsof -i :3000

# Kill it
kill -9 <PID>
```

The script now handles this gracefully - if port 3000 is already in use by a Fade server, it will reuse it.

### Node Not Responding
```bash
# Check if node is running
ps aux | grep repram-node-raw

# Check node logs
tail -50 raw-node1.log
```

### Messages Not Appearing
- Ensure 3-second polling is working (check browser console)
- Verify nodes are healthy: `curl http://localhost:808X/health`
- Check CORS is enabled (browser console for errors)

## Next Steps

1. **Try Docker Compose Setup**:
   ```bash
   cd fade
   docker-compose up
   ```

2. **Test Gossip Protocol**:
   ```bash
   ./start-gossip-multi-node.sh  # Uses cluster nodes with replication
   ```

3. **Deploy to Multiple Machines**:
   - Run nodes on different servers
   - Update proxy configuration
   - Test true distributed behavior

## Key Observations

### Simple Multi-Node Mode
- **No Gossip**: Messages stay on the node that received them
- **Load Balancing**: Proxy distributes requests across nodes
- **Failover**: Automatic redirect to healthy nodes
- **TTL Enforcement**: Messages expire independently on each node
- **Use Case**: Testing proxy logic, load balancing, and failover

### Gossip-Enabled Cluster Mode
- **Full Replication**: Messages appear on all nodes within 1-3 seconds
- **Source Tracking**: Node indicators show original message source (`[node-1]`, `[node-2]`, etc.)
- **Immediate Consistency**: Quorum-based writes ensure data durability
- **Network Partitions**: Cluster handles node failures gracefully
- **Dynamic Topology**: Bootstrap protocol for discovery, SYNC messages for updates
- **Monitoring Tools**: Real-time health and gossip message monitoring scripts
- **Use Case**: Testing true distributed behavior and REPRAM's replication capabilities

Both modes demonstrate REPRAM's distributed ephemeral storage capabilities, with gossip mode showing the full vision of the system!