#!/bin/bash

# Deploy Discord Bridge to GCP
echo "🚀 Deploying Discord Bridge to GCP..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "📝 Please copy .env.example to .env and fill in your Discord credentials"
    echo "   cp .env.example .env"
    echo "   nano .env"
    exit 1
fi

# Source environment variables
source .env

# Validate required environment variables
if [ -z "$DISCORD_TOKEN" ] || [ -z "$DISCORD_CHANNEL_ID" ] || [ -z "$DISCORD_GUILD_ID" ]; then
    echo "❌ Error: Missing required Discord credentials in .env file"
    echo "📝 Please ensure DISCORD_TOKEN, DISCORD_CHANNEL_ID, and DISCORD_GUILD_ID are set"
    exit 1
fi

# Export variables for docker-compose
export DISCORD_TOKEN
export DISCORD_CHANNEL_ID
export DISCORD_GUILD_ID

echo "✅ Environment variables loaded"
echo "🔧 Building and starting Discord bridge..."

# Build and start only the discord-bridge service
docker-compose up -d --build discord-bridge

echo "📊 Checking service status..."
docker-compose ps discord-bridge

echo "📋 Showing recent logs..."
docker-compose logs --tail=20 discord-bridge

echo "🎉 Discord bridge deployment complete!"
echo "📱 The bridge should now be syncing messages between Discord and REPRAM"
echo "🔍 View logs: docker-compose logs -f discord-bridge"