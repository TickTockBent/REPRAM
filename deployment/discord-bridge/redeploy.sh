#!/bin/bash

echo "🔄 REDEPLOYING DISCORD-REPRAM BRIDGE WITH OPTIMIZATIONS..."
echo "=================================================="

# Change to the GCP deployment directory
cd /home/ticktockbent/REPRAM/deployment/gcp

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ ERROR: docker-compose.yml not found!"
    echo "Please run this script from the REPRAM deployment/discord-bridge directory"
    exit 1
fi

echo "📦 Rebuilding Discord bridge container with latest changes..."
echo "This will take time on the e2-micro instance (30-40 minutes expected)"
echo ""

# Rebuild just the discord-bridge service
docker-compose build discord-bridge

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful! Restarting Discord bridge..."
    
    # Stop and remove the old container
    docker-compose stop discord-bridge
    docker-compose rm -f discord-bridge
    
    # Start the new container
    docker-compose up -d discord-bridge
    
    echo ""
    echo "🚀 Discord bridge redeployed with optimizations:"
    echo "   - Polling interval reduced from 10s to 3s"
    echo "   - Fixed double key display issue"
    echo "   - Added initial sync on startup"
    echo "   - Optimized to skip Discord-origin messages"
    echo ""
    echo "📊 Check bridge status at: https://node1.repram.io:8084/health"
    echo "📝 View logs with: docker-compose logs -f discord-bridge"
else
    echo ""
    echo "❌ Build failed! Check the error messages above."
    exit 1
fi