#!/bin/bash

# Test script for multi-node Fade cluster
echo "Testing REPRAM Fade multi-node cluster..."
echo

# Test individual nodes first
echo "=== Testing individual node health ==="
for port in 8080 8081 8082; do
    response=$(curl -s http://localhost:$port/health)
    if [ "$response" = "OK" ]; then
        echo "✓ Node on port $port: $response"
    else
        echo "✗ Node on port $port: failed"
    fi
done
echo

# Test proxy health
echo "=== Testing proxy health ==="
response=$(curl -s http://localhost:3000/api/health)
if [ "$response" = "OK" ]; then
    echo "✓ Proxy server: $response"
else
    echo "✗ Proxy server: failed"
fi
echo

# Try a simple raw API call directly to each node
echo "=== Testing raw API on individual nodes ==="
for port in 8080 8081 8082; do
    echo "Testing node on port $port..."
    result=$(curl -s -X POST http://localhost:$port/raw/put \
        -H "Content-Type: application/json" \
        -d "{\"data\":\"Test message from port $port\",\"ttl\":60}")
    
    if echo "$result" | grep -q "key"; then
        key=$(echo "$result" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
        echo "✓ Stored message with key: $key"
        
        # Try to retrieve it
        retrieve=$(curl -s http://localhost:$port/raw/get/$key)
        if echo "$retrieve" | grep -q "Test message"; then
            echo "✓ Retrieved message successfully"
        else
            echo "✗ Failed to retrieve message"
        fi
    else
        echo "✗ Failed to store message: $result"
    fi
    echo
done

echo "=== Testing Fade web interface ==="
echo "Open your browser to http://localhost:3000 to test the UI"
echo "You can now test gossip by:"
echo "1. Opening multiple browser windows/tabs to localhost:3000"
echo "2. Sending messages from different windows"
echo "3. Observing if messages appear in all windows"
echo
echo "Note: If cluster replication is not working, messages will still work"
echo "through the proxy server, which load balances across nodes."