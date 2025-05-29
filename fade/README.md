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

1. Run at least one REPRAM node in raw mode:
```bash
# From the main REPRAM directory
make build-raw
./bin/repram-node-raw
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
- **REPRAM Nodes**: Standard raw nodes that store unencrypted messages
- **Simple Web Server**: Go server that serves the static files

The client communicates directly with REPRAM nodes using the raw API endpoints:
- `POST /raw/put` - Store a message with TTL
- `GET /raw/get/{key}` - Retrieve a specific message
- `GET /health` - Check node health

## Message Format

Messages can be plain text or use the community format:
```
Plain: "Hello from Fade!"
Community: "Check-in from the west coast|Crypto-73|California"
```

The pipe-separated format enables optional callsigns and locations.

## Development

### Running Multiple Nodes

For a true distributed experience, run multiple nodes:

```bash
# Terminal 1
./bin/repram-node-raw -port 8080

# Terminal 2
./bin/repram-node-raw -port 8081 -gossip-port 9091

# Terminal 3
./bin/repram-node-raw -port 8082 -gossip-port 9092
```

### Customizing the UI

The web interface is in the `web/` directory:
- `index.html` - Main HTML structure
- `styles.css` - Dark theme styling
- `client.js` - REPRAM client implementation

### Configuration

Update the node URLs in `client.js`:
```javascript
this.nodes = [
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:8082'
];
```

## Production Deployment

For production use:

1. Deploy REPRAM nodes across multiple regions
2. Update client.js with production node URLs
3. Serve the web files via CDN or static hosting
4. Enable HTTPS for secure communication
5. Configure CORS on REPRAM nodes if needed

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