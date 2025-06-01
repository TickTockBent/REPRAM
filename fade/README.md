# REPRAM Fade - Ephemeral Message Board Demo

Fade is a demonstration project that showcases REPRAM's distributed ephemeral storage capabilities through a simple, accessible web-based message board.

## Overview

Fade demonstrates:
- **Ephemeral Storage**: Messages automatically expire based on TTL
- **Distributed Network**: Messages replicate across geographic nodes
- **Zero Authentication**: Anyone can read/write without accounts
- **Real-time Updates**: Watch messages appear and disappear
- **Community Features**: Optional callsign system for regular users

## Quick Start

### Prerequisites

1. Run at least one REPRAM cluster node:
```bash
# From the main REPRAM directory
make build-cluster
./bin/cluster-node
```

The node will start on port 8080 by default.

### Running the Fade UI

1. Navigate to the fade directory:
```bash
cd fade
```

2. Start the web server:
```bash
go run server.go
```

3. Open your browser to http://localhost:3000

### Using Fade

1. **Send a Message**: Type your message, select a TTL, and click Send
2. **Watch Messages**: New messages appear at the top of the board
3. **See TTL Countdown**: Watch the remaining time decrease in real-time
4. **Lookup Messages**: Use a message key to retrieve specific messages
5. **Monitor Network**: See node status and message statistics

## Architecture

Fade consists of:
- **Static Web UI**: HTML/CSS/JS client that runs in the browser
- **REPRAM Cluster Nodes**: Gossip-enabled nodes that replicate messages across the network
- **Fade Server**: Go proxy server that serves the web UI and load balances across nodes

The fade server proxies requests to REPRAM cluster nodes using standard API endpoints:
- `PUT /data/{key}?ttl=seconds` - Store a message with TTL
- `GET /data/{key}` - Retrieve a specific message
- `GET /health` - Check node health
- `GET /scan` - List all keys

## Message Format

Messages can be plain text or use the community format:
```
Plain: "Hello from Fade!"
Community: "Check-in from the west coast|Crypto-73|California"
```

The pipe-separated format enables optional callsigns and locations.

## Development

### Running Multiple Nodes

For a true distributed experience with gossip replication, use the provided scripts:

```bash
# Start 3-node cluster with gossip replication
./start-gossip-multi-node.sh

# Or use docker compose
docker-compose -f docker-compose-flux-test.yml up
```

This starts 3 cluster nodes with gossip protocol and 3 fade servers for testing.

### Customizing the UI

The web interface is in the `web/` directory:
- `index.html` - Main HTML structure
- `styles.css` - Dark theme styling
- `client.js` - REPRAM client implementation

### Configuration

The fade server is configured via environment variables:
```bash
# Configure cluster nodes
FADE_NODES=http://localhost:8080,http://localhost:8081,http://localhost:8082

# Configure web server port
PORT=3000
```

Or via command line flags:
```bash
./fade-server -nodes "http://node1:8080,http://node2:8080,http://node3:8080" -port 3000
```

## Production Deployment

For production deployment on Flux:

1. **Container Images**: Use `ticktockbent/repram-cluster-node` and `ticktockbent/fade-server`
2. **Multi-Server Architecture**: Deploy 3+ fade servers (Flux minimum) with identical config
3. **Cluster Nodes**: Deploy 3+ cluster nodes with gossip replication enabled
4. **Environment Variables**: Configure `FADE_NODES` and bootstrap peers for cluster formation
5. **Load Balancing**: Flux distributes traffic across healthy fade server instances
6. **Data Consistency**: Gossip protocol ensures messages replicate across all cluster nodes

See `docs/fade-flux-deployment-plan.md` for detailed deployment instructions.

## Community Features

The optional callsign system enables CB radio-style communication:
- Choose a unique callsign (e.g., "Crypto-73")
- Add your general location for context
- Build reputation through consistent use
- Coordinate "nets" at specific times

## Contributing

Fade is part of the REPRAM project. Contributions welcome!

## License

Same as REPRAM - see main project LICENSE file.