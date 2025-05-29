# How to Run REPRAM Fade Multi-Node Test

This guide walks you through running a multi-node REPRAM setup to test distributed ephemeral storage and see the Fade demo working across multiple nodes.

## Prerequisites

- Go 1.22+ installed
- Terminal access
- Web browser (Chrome/Firefox recommended)
- Ports 8080-8082 and 3000 available

## Quick Start (5 minutes)

### Step 1: Build the Project

```bash
cd /path/to/REPRAM
make build-raw
```

### Step 2: Start the Multi-Node Cluster

```bash
cd fade
./start-simple-multi-node.sh
```

You should see:
```
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

### Port Already in Use
```bash
# Find what's using the port
lsof -i :3000

# Kill it
kill -9 <PID>
```

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

2. **Test Gossip Protocol** (when debugged):
   ```bash
   ./start-multi-node.sh  # Uses cluster nodes
   ```

3. **Deploy to Multiple Machines**:
   - Run nodes on different servers
   - Update proxy configuration
   - Test true distributed behavior

## Key Observations

- **No Gossip**: Messages stay on the node that received them
- **Load Balancing**: Proxy distributes requests across nodes
- **Failover**: Automatic redirect to healthy nodes
- **TTL Enforcement**: Messages expire independently on each node
- **Ephemeral Nature**: No persistence, everything expires

This demonstrates REPRAM's core distributed ephemeral storage capabilities!