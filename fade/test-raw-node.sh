#!/bin/bash

echo "Testing REPRAM raw node endpoints..."
echo

# Test health endpoint
echo "1. Testing health endpoint:"
curl -s http://localhost:8080/health | jq . || echo "Failed to connect to health endpoint"
echo

# Test raw put endpoint
echo "2. Testing raw/put endpoint:"
RESPONSE=$(curl -s -X POST http://localhost:8080/raw/put \
  -H "Content-Type: application/json" \
  -d '{"data": "Test message from curl", "ttl": 3600}')

echo "Response: $RESPONSE"
KEY=$(echo $RESPONSE | jq -r .key)
echo "Extracted key: $KEY"
echo

# Test raw get endpoint
if [ ! -z "$KEY" ] && [ "$KEY" != "null" ]; then
    echo "3. Testing raw/get endpoint with key: $KEY"
    curl -s http://localhost:8080/raw/get/$KEY | jq .
else
    echo "3. Skipping get test - no valid key obtained"
fi
echo

echo "4. Testing proxy endpoints through Fade server:"
echo "Health check via proxy:"
curl -s http://localhost:3000/api/health | jq . || echo "Failed to connect via proxy"
echo

echo "Raw put via proxy:"
curl -s -X POST http://localhost:3000/api/raw/put \
  -H "Content-Type: application/json" \
  -d '{"data": "Test message via proxy", "ttl": 3600}' | jq .