#!/bin/bash

echo "=== REPRAM Phase 2 Cluster Test ==="

# Build the cluster node
make build-cluster

# Start 3 cluster nodes
echo "Starting cluster nodes..."

# Node 1 (Bootstrap node)
NODE_ID=node-1 NODE_ADDRESS=localhost NODE_PORT=8090 HTTP_PORT=8080 REPLICATION_FACTOR=3 ./bin/repram-cluster-node &
NODE1_PID=$!
sleep 2

# Node 2
NODE_ID=node-2 NODE_ADDRESS=localhost NODE_PORT=8091 HTTP_PORT=8081 REPLICATION_FACTOR=3 BOOTSTRAP_NODES=localhost:8090 ./bin/repram-cluster-node &
NODE2_PID=$!
sleep 2

# Node 3
NODE_ID=node-3 NODE_ADDRESS=localhost NODE_PORT=8092 HTTP_PORT=8082 REPLICATION_FACTOR=3 BOOTSTRAP_NODES=localhost:8090,localhost:8091 ./bin/repram-cluster-node &
NODE3_PID=$!
sleep 3

echo "Cluster nodes started. Testing distributed writes..."

# Test distributed write
echo "Writing data to node 1..."
curl -X PUT http://localhost:8080/cluster/put/test-key \
  -H "X-TTL: 120" \
  -d "Hello REPRAM Cluster!" \
  -w "\nStatus: %{http_code}\n"

sleep 2

# Test reading from different nodes
echo -e "\nReading from node 1:"
curl http://localhost:8080/cluster/get/test-key
echo

echo -e "\nReading from node 2:"
curl http://localhost:8081/cluster/get/test-key
echo

echo -e "\nReading from node 3:"
curl http://localhost:8082/cluster/get/test-key
echo

# Cleanup
echo -e "\nStopping cluster nodes..."
kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null
sleep 2

echo "Cluster test completed!"