# Discord-REPRAM Bridge

An ephemeral messaging bridge between Discord and REPRAM, featuring automatic TTL-based message deletion and bi-directional synchronization.

## Features

- **🔄 Bi-directional sync**: Messages flow between Discord and REPRAM
- **⏰ TTL-based expiration**: Messages auto-delete when their TTL expires
- **🎯 TTL commands**: Users can set custom TTLs with `/ttl60 Hello world`
- **🔑 Key embedding**: REPRAM keys embedded in Discord messages for tracking
- **🌐 Multi-node support**: Connects to multiple REPRAM nodes with failover
- **📊 Visual TTL display**: Shows remaining time for each message

## Setup

### 1. Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and bot
3. Copy the bot token
4. Invite bot to your server with appropriate permissions:
   - Read Messages
   - Send Messages
   - Manage Messages (for deletion)
   - Add Reactions

### 2. Configuration

Copy and edit the configuration file:

```bash
cp config.yaml.example config.yaml
nano config.yaml
```

Update the following values:
- `discord.token`: Your Discord bot token
- `discord.channel_id`: Discord channel ID for bridging
- `discord.guild_id`: Discord server (guild) ID
- `repram.nodes`: List of REPRAM node URLs

### 3. Build and Run

```bash
# Install dependencies
go mod tidy

# Build the bridge
go build -o discord-bridge

# Run the bridge
./discord-bridge
```

### 4. Deploy to GCP VM

```bash
# Copy to your GCP VM
scp -r . username@your-gcp-ip:/home/username/discord-bridge/

# SSH to VM and run
ssh username@your-gcp-ip
cd discord-bridge
go build -o discord-bridge
./discord-bridge
```

## Usage

### Basic Messaging

- **Discord → REPRAM**: Type any message in the configured Discord channel
- **REPRAM → Discord**: Messages from FADE or other clients appear in Discord with 🌐 prefix

### TTL Commands

Set custom TTL for your messages:

```
/ttl60 This message expires in 60 seconds
/ttl3600 This lasts for 1 hour
/ttl86400 This lasts for 1 day
```

### Message Format

The bridge supports FADE's message format:
```
message|author|timestamp|ttl|source
```

## Architecture

```
┌─────────────────┐    WebSocket    ┌─────────────────┐
│     Discord     │ ◄──────────────► │   Bridge Bot    │
│    Channel      │                 │   (Go Service)  │
└─────────────────┘                 └─────────────────┘
                                             │
                                    HTTP API │
                                             ▼
                                  ┌─────────────────────┐
                                  │  REPRAM Cluster     │
                                  │  (3 Nodes on GCP)   │
                                  └─────────────────────┘
                                             ▲
                                    HTTP API │
                                             │
                                  ┌─────────────────────┐
                                  │    FADE Demo        │
                                  │  (Vercel Static)    │
                                  └─────────────────────┘
```

## Configuration Reference

| Section | Key | Description | Default |
|---------|-----|-------------|---------|
| `discord` | `token` | Discord bot token | Required |
| `discord` | `channel_id` | Channel to bridge | Required |
| `repram` | `nodes` | REPRAM node URLs | Required |
| `repram` | `default_ttl` | Default message TTL | 3600s |
| `bridge` | `poll_interval` | REPRAM polling interval | 10s |
| `bridge` | `cleanup_interval` | Cleanup check interval | 60s |
| `ttl_commands` | `enabled` | Enable TTL commands | true |
| `ttl_commands` | `prefix` | TTL command prefix | "/ttl" |

## Troubleshooting

### Bot Not Responding
- Check bot token is correct
- Verify bot has necessary permissions
- Check if bot is in the correct channel

### Messages Not Syncing
- Verify REPRAM nodes are accessible
- Check network connectivity to GCP
- Review logs for API errors

### TTL Not Working
- Ensure cleanup interval is appropriate
- Check Discord API rate limits
- Verify message tracking is working

## Logs

The bridge logs all operations:
- Message synchronization
- TTL parsing and validation
- Discord API calls
- REPRAM API calls
- Cleanup operations

Log level can be configured in `config.yaml`.

## Security

- Bot token stored in config file (keep secure)
- No sensitive data stored in Discord messages
- REPRAM keys embedded as invisible Unicode characters
- All API calls use HTTPS where possible

## Performance

- Concurrent request handling (configurable)
- Connection pooling for HTTP clients
- Round-robin load balancing across REPRAM nodes
- Graceful failover on node unavailability