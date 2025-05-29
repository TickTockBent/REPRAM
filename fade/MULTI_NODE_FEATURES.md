# REPRAM Fade Multi-Node Features

## New Features Available

### 1. **Node Selector Dropdown**
In the connection status bar, you'll see a dropdown that lets you choose:
- **Auto (Load Balance)** - Uses the proxy to distribute requests across all nodes
- **Node 1 (8080)** - Direct connection to node 1 only
- **Node 2 (8081)** - Direct connection to node 2 only
- **Node 3 (8082)** - Direct connection to node 3 only

### 2. **Connection Status Monitoring**
The connection indicator now:
- Shows **SCANNING NETWORK...** with spinning icon during polling
- Shows **CONNECTED [node-X]** when connected
- Shows **CONNECTION ERROR** with blinking red when nodes are down
- Updates every 3 seconds to detect node failures

### 3. **Node Identification**
- Each message shows which node it's stored on: `[node-1]`, `[node-2]`, `[node-3]`
- When in direct mode, shows `[Direct: Node 8080]` etc.
- Network status shows all active nodes

### 4. **Cool Key Names**
Messages now have memorable keys like:
- `msg-quantum-phoenix-1748557236937000000900`
- `msg-cyber-nexus-1748557236937000000123`
- `msg-ethereal-vortex-1748557236937000000456`

## How to Test Multi-Node Behavior

### Test 1: Load Balancing (Default)
1. Keep node selector on "Auto (Load Balance)"
2. Send multiple messages quickly
3. Watch the `[node-X]` indicator - messages will be distributed across nodes

### Test 2: Direct Node Connection
1. Select "Node 1 (8080)" from dropdown
2. Send a message - it will show `[node-8080]`
3. Switch to "Node 2 (8081)"
4. Notice the screen clears and reloads (different node = different data!)
5. Send another message - it will show `[node-8081]`

### Test 3: Node Isolation
1. Select Node 1 and send message "Hello from Node 1"
2. Select Node 2 and send message "Hello from Node 2"
3. Select Node 3 and send message "Hello from Node 3"
4. Switch between nodes - each has its own messages!

### Test 4: Node Failure Detection
1. Stop one node: `lsof -i :8081 | grep repram | awk '{print $2}' | xargs kill`
2. If connected to that node, you'll see "CONNECTION ERROR" within 3 seconds
3. Switch to another node to continue
4. In Auto mode, the proxy handles failover automatically

## Understanding the Behavior

- **Auto Mode**: Messages are distributed round-robin across healthy nodes
- **Direct Mode**: All operations go to one specific node
- **No Gossip**: In this simple setup, nodes don't share data (gossip is disabled)
- **Ephemeral**: Messages still expire based on TTL regardless of node

## Visual Indicators

- **Connection Status**: Real-time health monitoring with animations
- **Node Tags**: Each message shows its storage location
- **Network Status**: Shows all nodes and their health
- **Scanning Animation**: Visual feedback during network operations

This setup perfectly demonstrates REPRAM's distributed nature and how different nodes can store different subsets of data!