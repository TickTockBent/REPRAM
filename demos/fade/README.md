# 💨 FADE - Ephemeral Messaging Demo

<div align="center">

**F**ast **A**ccess **D**istributed **E**phemeral Messaging

*Experience true ephemeral communication where messages disappear forever*

[![Live Demo](https://img.shields.io/badge/🚀%20Live-Demo-ff00ff?style=for-the-badge&logo=github)](https://ticktockbent.github.io/REPRAM/web/fade/)
[![Documentation](https://img.shields.io/badge/📚%20Read-Docs-00ffff?style=for-the-badge&logo=gitbook)](https://github.com/ticktockbent/REPRAM)

![FADE Demo](https://img.shields.io/badge/Status-Production%20Ready-00ff00?style=flat-square)
![Privacy](https://img.shields.io/badge/Privacy-First-ff00ff?style=flat-square)
![Ephemeral](https://img.shields.io/badge/Data-Ephemeral-ffff00?style=flat-square)

</div>

---

## 🎯 What is FADE?

**FADE** is a demonstration of REPRAM's ephemeral storage capabilities through a real-time messaging interface. Messages automatically expire and are permanently deleted from memory - no forensics, no recovery, no traces.

### ✨ Key Features

| Feature | Description |
|---------|-------------|
| **⏰ Auto-Expiration** | Messages disappear forever after TTL expires |
| **🔒 Privacy-First** | No persistent storage, no logs, no traces |
| **⚡ Real-Time** | WebSocket-powered live messaging |
| **🌐 Distributed** | Backed by REPRAM's distributed node network |
| **🎨 Cyberpunk UI** | 80's hackerpunk aesthetic with terminal vibes |

---

## 🚀 Quick Start

### 🖥️ Development Setup

```bash
# Start the FADE server
go run server.go

# Open the web interface
open http://localhost:8080
```

### 🐳 Docker Deployment

```bash
# Start a multi-node cluster
docker-compose up -d

# View logs
docker-compose logs -f
```

### 🌍 Live Demo
Visit the **[live demo](https://ticktockbent.github.io/REPRAM/web/fade/)** (frontend only - requires backend for full functionality)

---

## 🏗️ Architecture

```
┌─────────────────┐    WebSocket    ┌─────────────────┐
│   Web Client    │ ◄──────────────► │   FADE Server   │
│   (Browser)     │                 │   (Proxy)       │
└─────────────────┘                 └─────────────────┘
                                             │
                                    HTTP API │
                                             ▼
                                    ┌─────────────────┐
                                    │  REPRAM Nodes   │
                                    │  (Distributed)  │
                                    └─────────────────┘
```

### 🔧 Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| **Web Client** | User interface for messaging | HTML5 + WebSockets |
| **FADE Server** | Proxy between client and REPRAM | Go + Gorilla WebSocket |
| **REPRAM Nodes** | Distributed ephemeral storage | Go + REST API |

---

## 🎮 How to Use

### 💬 Sending Messages

1. **Choose a callsign** - Your unique identifier for the session
2. **Set TTL** - How long your message should live (60s to 3600s)
3. **Type your message** - Express yourself (max 1000 characters)
4. **Send** - Watch it appear in real-time for all users

### ⏱️ Message Lifecycle

```
📝 Created → 📡 Broadcast → ⏰ Countdown → 💀 Auto-Delete
```

| Phase | Description | Visual Indicator |
|-------|-------------|------------------|
| **Active** | Message is live and visible | Green glow effect |
| **Warning** | 30 seconds remaining | Yellow warning flash |
| **Expiring** | Final 10 seconds | Red critical flash |
| **Deleted** | Permanently removed | Glitch dissolution effect |

---

## 🎨 Features Showcase

### 🌈 Visual Effects

- **Matrix rain background** - Flowing code aesthetic
- **CRT screen effect** - Authentic terminal simulation  
- **Glitch animations** - Data corruption effects on expiration
- **Real-time updates** - Smooth WebSocket synchronization

### 🔐 Privacy Features

- **No persistence** - Messages exist only in RAM
- **Auto-expiration** - Guaranteed deletion after TTL
- **No user tracking** - Anonymous ephemeral sessions
- **No message logs** - Zero forensic footprint

### 📱 Technical Features

- **Responsive design** - Works on desktop and mobile
- **Real-time sync** - All clients see updates instantly
- **Error handling** - Graceful degradation on failures
- **Performance optimized** - Smooth even with many messages

---

## 🛠️ Development

### 📋 Prerequisites

- **Go 1.19+** for the server
- **Modern browser** with WebSocket support
- **REPRAM nodes** running (can use docker-compose)

### 🔧 Local Development

```bash
# Clone the repository
git clone https://github.com/ticktockbent/REPRAM.git
cd REPRAM/demos/fade

# Start local REPRAM nodes
docker-compose up -d

# Run the FADE server
go run server.go

# Open in browser
open http://localhost:8080
```

### 🐛 Debugging

```bash
# View server logs
go run server.go -debug

# Monitor REPRAM nodes
docker-compose logs -f

# Check node health
curl http://localhost:8081/health
```

---

## 🎭 Use Cases

| Scenario | Description |
|----------|-------------|
| **🕵️ Whistleblowing** | Share sensitive information without permanent traces |
| **💼 Corporate Comms** | Internal discussions that shouldn't be archived |
| **🎮 Gaming** | Temporary team coordination and strategy |
| **📱 Social Events** | Event-specific chats that auto-cleanup |
| **🔬 Research** | Collaborate on sensitive data without retention |

---

## ⚠️ Important Notes

> **🔒 Privacy Notice**: While FADE provides ephemeral storage, remember that:
> - Messages are visible to all users during their lifetime
> - Network traffic could potentially be intercepted
> - This is a demonstration, not a security-audited product

> **🚧 Demo Limitations**: The live demo (frontend only) cannot send/receive messages without the backend server running.

---

<div align="center">

**Experience Ephemeral Communication**

*"Data that exists only when needed, disappears when done"*

[🏠 Home](https://github.com/ticktockbent/REPRAM) • [🌳 Synth-Tree Demo](../synth-tree/) • [🚀 Live Demo](https://ticktockbent.github.io/REPRAM/web/fade/)

---

**Built with ❤️ for the REPRAM Project**

</div>