# SYNAPTIC MESH PROTOCOL

**Neural Network Discovery Simulation**

A cyberpunk-themed interactive simulation of the REPRAM discovery protocol, visualized as a self-organizing neural network with 80's hackerpunk aesthetics.

## 🎮 How to Run

```bash
make synaptic-mesh-demo
```

Then open http://localhost:8000/demos/discovery-protocol/hackerpunk.html

## 🧠 What is the Synaptic Mesh Protocol?

The Synaptic Mesh Protocol is REPRAM's self-organizing tree discovery system, visualized as a neural network where nodes automatically find optimal connections based on latency and capacity constraints.

### Node Types
- **α, β, γ Root Nodes** (Red): Global bootstrap nodes that coordinate the network
- **Trunk Nodes** (Orange): Regional distribution points connected to roots
- **Branch Nodes** (Green): Local cluster hubs that serve nearby areas  
- **Leaf Nodes** (Cyan): Edge nodes that connect to the nearest branch
- **Discovering Nodes** (Purple): New nodes searching for optimal attachment points

### Network Traffic
Watch the glowing data packets flow between nodes:
- **Purple packets**: Topology discovery requests
- **Pink packets**: Network topology responses  
- **Green packets**: Node attachment confirmations
- **Orange packets**: Connection confirmations
- **Yellow packets**: Node migration traffic
- **Teal packets**: General network maintenance

## 🎛️ Interactive Features

- **ADD NODE**: Inject a new node into the mesh
- **ADD 5 NODES**: Rapid expansion to watch clustering behavior
- **RUN DISCOVERY ROUND**: Trigger network optimization
- **AUTO RUN**: Enable autonomous network evolution
- **RESET NETWORK**: Purge all nodes except roots

## 🌐 Network Behavior

### Discovery Process
1. **Neural Injection**: Node materializes in random location
2. **Topology Scan**: Contacts all root nodes for network map
3. **Optimal Attachment**: Connects to best available parent based on latency
4. **Type Assignment**: Becomes Leaf → Branch → Trunk based on attachment depth

### Self-Optimization
- Nodes periodically evaluate better attachment opportunities
- Migration requires 25% latency improvement
- 10-second cooldown prevents network thrashing
- Failed attachments trigger automatic orphan reintegration

### Realistic Constraints
- **Root capacity**: 15 connections each
- **Trunk capacity**: 8 connections each  
- **Branch capacity**: 15 connections each
- **Leaf capacity**: 0 connections (edge nodes)

## 🎨 Cyberpunk Aesthetics

- **Matrix green** primary interface with neon accents
- **CRT scanlines** and screen flicker effects
- **Glitch text** animations on headers
- **Pulsing node glow** with hover interactions
- **Animated connection lines** between network nodes
- **Terminal-style** event logging with color coding

## 🔬 Protocol Testing

This simulation serves as a realistic testbed for the actual REPRAM discovery protocol, implementing:
- Geographic latency calculations
- Capacity-driven network growth
- Hierarchical tree organization
- Dynamic rebalancing algorithms
- Failure recovery mechanisms

Perfect for understanding how distributed networks self-organize and optimize over time.

---

**SYNAPTIC-MESH v0.1 "Neural-Matrix" // REPRAM.io**