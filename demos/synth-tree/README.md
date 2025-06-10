# 🌳 REPRAM Synth-Tree Visualization

<div align="center">

**Interactive Hierarchical Network Protocol Demonstration**

*Visualize how distributed nodes self-organize into efficient tree structures*

[![Live Demo](https://img.shields.io/badge/🚀%20Live-Demo-00ff00?style=for-the-badge&logo=github)](https://ticktockbent.github.io/REPRAM/web/synth-tree/)
[![Documentation](https://img.shields.io/badge/📚%20Read-Docs-00ffff?style=for-the-badge&logo=gitbook)](https://github.com/ticktockbent/REPRAM)

</div>

---

## 🎯 Overview

An interactive web-based simulation of the **REPRAM synth-tree protocol** that visualizes how nodes self-organize into an efficient hierarchical network structure in real-time.

## 🚀 Quick Start

### Option 1: Direct File Access
```bash
# From the project root
open demos/synth-tree/index.html
```

### Option 2: Local Web Server
```bash
# Start a simple HTTP server
python3 -m http.server 8000

# Navigate to the demo
open http://localhost:8000/demos/synth-tree/
```

### Option 3: Live Demo
Visit the **[live demo](https://ticktockbent.github.io/REPRAM/web/synth-tree/)** hosted on GitHub Pages.

## ✨ Features

### 🎮 Interactive Controls
| Control | Description |
|---------|-------------|
| **Add Node** | Adds a single node with random geographic location |
| **Add 5 Nodes** | Quickly add multiple nodes to see clustering behavior |
| **Run Discovery** | Triggers network rebalancing and optimization |
| **Auto Run** | 🔄 Continuously adds nodes and runs discovery rounds |
| **Reset Network** | 🗑️ Clear all nodes except roots and start fresh |

### 👁️ Visualization Modes
1. **🌲 Tree Structure** - Hierarchical tree layout showing parent-child relationships
2. **🌍 Geographic** - Nodes positioned by actual lat/lon coordinates  
3. **⭕ Radial Layout** - Circular arrangement showing network depth levels

### 📊 Real-time Statistics
- 📈 Node counts by type (Root, Trunk, Branch, Leaf)
- 📏 Average network depth
- 💾 Capacity utilization percentage

### 📝 Event Log
- 🕒 Tracks all network events with timestamps
- 🎨 Color-coded messages (✅ success, ⚠️ warning, ❌ error)

## 🧠 Synth-Tree Protocol Demonstration

The simulation demonstrates key **synth-tree protocol features**:

### 🔄 Core Behaviors
| Feature | Description |
|---------|-------------|
| **🎯 Self-Organization** | New nodes automatically find optimal positions based on latency |
| **🌍 Geographic Clustering** | Nodes naturally group with geographically close peers |
| **⚖️ Dynamic Rebalancing** | Nodes migrate to better parents when 25%+ improvement is possible |
| **📈 Capacity Management** | Automatic promotion when parent nodes reach capacity |
| **🛠️ Failure Recovery** | Click any non-root node to remove it and watch orphans reattach |

### 🎨 Node Types

| Type | Color | Role | Capacity |
|------|-------|------|----------|
| **🔴 Root** | Red | 3 static bootstrap nodes (US, EU, Asia) | ∞ |
| **🟠 Trunk** | Orange | Connect directly to roots | 5 |
| **🟢 Branch** | Green | Create local clusters | 10 |
| **🔵 Leaf** | Blue | Edge nodes with no children | 0 |

### 🌐 Latency Simulation

The demo calculates **realistic network latency** based on geographic distance:

- 📐 Uses **Haversine formula** for Earth surface distance
- ⏱️ Converts to milliseconds (`100km ≈ 1ms` base latency)
- 🔗 Displayed on connections when **"Show Latency"** is enabled

## 💡 Tips for Exploration

| Step | Action | What to Observe |
|------|--------|-----------------|
| **1** | 🚀 Start with **"Auto Run"** | Watch the network grow organically |
| **2** | 👁️ **Switch view modes** | See different perspectives of same network |
| **3** | ➕ **Add many nodes quickly** | How the tree rebalances itself |
| **4** | 🗑️ **Remove branch nodes** | Observe failure recovery mechanisms |
| **5** | 📊 **Watch statistics** | See how depth stays logarithmic with size |

---

<div align="center">

**Built with ❤️ for the REPRAM Project**

[🏠 Home](https://github.com/ticktockbent/REPRAM) • [📚 Docs](https://github.com/ticktockbent/REPRAM/tree/main/docs) • [🚀 Live Demo](https://ticktockbent.github.io/REPRAM/web/synth-tree/)

</div>