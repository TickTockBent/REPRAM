# REPRAM Synth-Tree Web Demo

An interactive web-based simulation of the REPRAM synth-tree protocol that visualizes how nodes self-organize into an efficient hierarchical network structure.

## How to Run

Simply open `index.html` in a modern web browser:

```bash
# From the project root
open demos/synth-tree/index.html

# Or start a simple HTTP server
python3 -m http.server 8000
# Then navigate to http://localhost:8000/demos/synth-tree/
```

## Features

### Interactive Controls
- **Add Node**: Adds a single node with random geographic location
- **Add 5 Nodes**: Quickly add multiple nodes to see clustering behavior
- **Run Discovery Round**: Triggers network rebalancing and optimization
- **Auto Run**: Continuously adds nodes and runs discovery rounds
- **Reset Network**: Clear all nodes except roots and start fresh

### Visualization Modes
1. **Tree Structure**: Hierarchical tree layout showing parent-child relationships
2. **Geographic**: Nodes positioned by actual lat/lon coordinates
3. **Radial Layout**: Circular arrangement showing network depth levels

### Real-time Statistics
- Node counts by type (Root, Trunk, Branch, Leaf)
- Average network depth
- Capacity utilization percentage

### Event Log
- Tracks all network events with timestamps
- Color-coded messages (success, warning, error)

## Synth-Tree Protocol Demonstration

The simulation demonstrates key synth-tree protocol features:

1. **Self-Organization**: New nodes automatically find optimal positions based on latency
2. **Geographic Clustering**: Nodes naturally group with geographically close peers
3. **Dynamic Rebalancing**: Nodes migrate to better parents when 25%+ improvement is possible
4. **Capacity Management**: Automatic promotion when parent nodes reach capacity
5. **Failure Recovery**: Click any non-root node to remove it and watch orphans reattach

## Node Types

- **Root Nodes** (Red): 3 static bootstrap nodes in US, EU, and Asia
- **Trunk Nodes** (Orange): Connect directly to roots, capacity of 5
- **Branch Nodes** (Green): Create local clusters, capacity of 10
- **Leaf Nodes** (Blue): Edge nodes with no children

## Latency Simulation

The demo calculates realistic network latency based on geographic distance:
- Uses Haversine formula for Earth surface distance
- Converts to milliseconds (100km ≈ 1ms base latency)
- Displayed on connections when "Show Latency" is enabled

## Tips for Exploration

1. Start with "Auto Run" to watch the network grow organically
2. Switch between view modes to see different perspectives
3. Add many nodes quickly to see how the tree rebalances
4. Remove branch nodes to observe failure recovery
5. Watch the statistics to see how depth stays logarithmic with size