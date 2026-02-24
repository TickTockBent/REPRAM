# repram-mcp

MCP server for [REPRAM](https://github.com/ticktockbent/REPRAM) — gives AI agents tools to store, retrieve, and list ephemeral data on the REPRAM network.

## Tools

| Tool | Description |
|------|-------------|
| `repram_store` | Store data with automatic expiration (TTL). Returns a key for retrieval. |
| `repram_retrieve` | Retrieve data by key. Returns null if expired or missing. |
| `repram_list_keys` | List stored keys, optionally filtered by prefix. |

## Configuration

### Claude Code

Add to your MCP settings (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "repram": {
      "command": "npx",
      "args": ["repram-mcp"],
      "env": {
        "REPRAM_URL": "http://localhost:8080"
      }
    }
  }
}
```

### Docker

```json
{
  "mcpServers": {
    "repram": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "REPRAM_URL=http://host.docker.internal:8080", "repram/mcp"],
      "env": {}
    }
  }
}
```

### Other MCP Clients

Any MCP client that supports stdio transport can use this server. Set the command to `npx repram-mcp` or `node /path/to/dist/index.js` and pass `REPRAM_URL` as an environment variable.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REPRAM_URL` | `http://localhost:8080` | Base URL of the REPRAM node to connect to |

## Building from Source

```bash
npm install
npm run build
```

## License

MIT
