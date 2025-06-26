#!/bin/bash

# Open port 8084 for Discord bridge health endpoint
echo "🔧 Opening port 8084 for Discord bridge health endpoint..."

gcloud compute firewall-rules create repram-discord-health \
  --allow=tcp:8084 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=repram-cluster \
  --project=repram-463923 \
  --description="Discord bridge health endpoint"

echo "✅ Port 8084 is now open for Discord bridge health checks!"