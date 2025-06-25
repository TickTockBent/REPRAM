# Discord-REPRAM Bridge Deployment Guide

## Overview

The Discord-REPRAM Bridge enables bidirectional synchronization between Discord channels and the REPRAM ephemeral messaging system. Messages posted in Discord are synced to REPRAM with TTL-based expiration, and messages from REPRAM (like FADE) appear in Discord.

## Features

- **Bidirectional Sync**: Discord ↔ REPRAM message synchronization
- **TTL Commands**: Use `/ttl60 Hello` to set custom expiration times
- **Auto-deletion**: Messages automatically disappear from Discord when TTL expires
- **Rate Limiting**: Respects Discord API limits (3 deletions/second)
- **Cyberpunk Aesthetic**: ◆ and ◇ prefixes for visual distinction

## Prerequisites

1. **Discord Bot Setup**:
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Create a new application
   - Go to "Bot" section and create a bot
   - Copy the bot token
   - Enable "Message Content Intent" under Privileged Gateway Intents

2. **Discord Channel Setup**:
   - Right-click your Discord channel → "Copy ID" (enable Developer Mode first)
   - Right-click your Discord server → "Copy ID"
   - Invite the bot to your server with "Send Messages" and "Manage Messages" permissions

3. **REPRAM Cluster**: Ensure your REPRAM cluster is running and accessible

## Deployment to GCP

### Step 1: Configure Environment

```bash
# SSH to your GCP VM
gcloud compute ssh repram-cluster --zone=us-central1-a --project=repram-463923

# Navigate to deployment directory
cd REPRAM/deployment/gcp/

# Copy environment template
cp .env.example .env

# Edit with your Discord credentials
nano .env
```

Fill in your `.env` file:
```env
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CHANNEL_ID=your_discord_channel_id_here
DISCORD_GUILD_ID=your_discord_guild_id_here
```

### Step 2: Deploy

```bash
# Run deployment script
./deploy-discord-bridge.sh
```

### Step 3: Verify

```bash
# Check if bridge is running
docker-compose ps discord-bridge

# View logs
docker-compose logs -f discord-bridge

# Test by posting a message in Discord
# It should appear in REPRAM and be accessible via FADE
```

## Usage

### Discord → REPRAM

Post messages in Discord:
```
Hello world!
/ttl300 This message expires in 5 minutes
/ttl3600 This message expires in 1 hour
```

Messages appear in REPRAM with keys and can be viewed on FADE.

### REPRAM → Discord

Messages created via FADE appear in Discord with proper formatting:

**FADE message with callsign and location:**
```
◆ FADE: **ALICE (NYC)**: Hello from the Big Apple!
⏱️ TTL: 55m
🔑 `msg-neon-phoenix-1703025600000000123`
```

**FADE message with callsign only:**
```
◆ FADE: **BOB**: Just saying hi!
⏱️ TTL: 2h 15m
🔑 `msg-cyber-wraith-1703025700000000456`
```

**FADE message without callsign:**
```
◆ FADE: **unknown**: Anonymous message here
⏱️ TTL: 45m
🔑 `msg-quantum-serpent-1703025800000000789`
```

## TTL Commands

- `/ttl60 message` - 1 minute
- `/ttl300 message` - 5 minutes  
- `/ttl3600 message` - 1 hour
- `/ttl86400 message` - 24 hours

Valid range: 5 minutes (300s) to 1 week (604800s)

## Monitoring

```bash
# View bridge logs
docker-compose logs -f discord-bridge

# Check bridge health
docker-compose ps discord-bridge

# View all services
docker-compose ps
```

## Troubleshooting

### Bot Not Responding
- Check bot token in `.env`
- Verify bot has proper permissions in Discord
- Check logs: `docker-compose logs discord-bridge`

### Messages Not Syncing
- Verify REPRAM cluster is healthy: `curl https://node1.repram.io/health`
- Check network connectivity between containers
- Review bridge configuration in `config.yaml`

### Rate Limiting
- Discord allows 5 deletions per 5 seconds
- Bridge automatically queues deletions and retries
- Check logs for rate limit warnings

## Configuration

The bridge reads from `config.yaml` with environment variable overrides:

- `DISCORD_TOKEN` overrides `discord.token`
- `DISCORD_CHANNEL_ID` overrides `discord.channel_id`  
- `DISCORD_GUILD_ID` overrides `discord.guild_id`

All other settings (TTL ranges, rate limits, prefixes) are configured in `config.yaml`.

## Architecture

```
Discord Channel ←→ Discord Bridge ←→ REPRAM Cluster ←→ FADE Web App
                        ↓
                  Message Tracker
                  (TTL Monitoring)
```

The bridge maintains a local database of message mappings between Discord message IDs and REPRAM keys, enabling proper cleanup when TTLs expire.