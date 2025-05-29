# REPRAM Demo Project: Ephemeral Message Board

## Project Overview

The Ephemeral Message Board is the first demonstration project for REPRAM, designed to showcase the core capabilities of the distributed ephemeral storage network through a simple, accessible chat room experience. This project serves as both a working demonstration and a tutorial for developers interested in understanding and deploying REPRAM.

## Goals

### Primary Objectives
- **Demonstrate Core REPRAM Functionality**: Show key-value storage with TTL in action without technical barriers
- **Illustrate Network Distribution**: Display real-time replication across geographic nodes
- **Provide Developer Tutorial**: Example code and deployment instructions
- **Create Accessible Entry Point**: Zero-friction experience that anyone can immediately use

### Educational Outcomes
- Users understand ephemeral storage concepts viscerally
- Developers see practical REPRAM API usage in its simplest form
- Network operators learn deployment procedures
- Business stakeholders grasp compliance benefits through working example

## Demo Concept

### Core Philosophy
An open, unencrypted global chat room where:
- **Anyone can read everything** - no access control, no accounts
- **Messages automatically disappear** - TTL enforcement in action
- **Geographic distribution works transparently** - 15-minute propagation becomes a feature
- **Anonymous by default, personal by choice** - optional callsigns via client-side conventions

### User Experience Flow
1. **Visit fade.repram.io**: See live message board with auto-refreshing content
2. **Read Global Messages**: Watch real-time conversation from around the world
3. **Post Anonymous Message**: Type message, select TTL, submit instantly
4. **Watch Propagation**: Message appears globally over ~15 minutes
5. **Observe Expiration**: Watch messages fade and disappear automatically
6. **Optional Community**: Use SDK clients for CB radio-style callsigns

## Technical Architecture

### Message Format Convention

#### Anonymous Messages (Web Portal)
```
Raw message content: "Hello from the REPRAM demo! This will vanish in 1 hour"

Node storage:
key: "msg_1704123456_abc123"
value: "Hello from the REPRAM demo! This will vanish in 1 hour"
ttl: 3600
```

#### Community Messages (SDK Clients)
```
Raw message content: "Evening net check-in. Network conditions good tonight.|Crypto-73|Pacific Northwest"

Node storage:
key: "msg_1704123456_def456"  
value: "Evening net check-in. Network conditions good tonight.|Crypto-73|Pacific Northwest"
ttl: 7200
```

#### Message Parsing Convention
```
Format: "message_text|callsign|location"
- message_text: The actual message content
- callsign: Optional radio-style identifier (e.g., "Crypto-73")
- location: Optional general location (e.g., "Pacific Northwest")

If no callsign: just store the message text directly
If callsign present: append with pipe separators
```

### Frontend Implementation

#### HTML Interface
```html
<!DOCTYPE html>
<html>
<head>
    <title>REPRAM Demo - Ephemeral Message Board</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        .message-board { 
            height: 400px; 
            overflow-y: auto; 
            border: 1px solid #ccc; 
            padding: 15px;
            background: #f9f9f9;
            font-family: 'Courier New', monospace;
        }
        .message { 
            margin: 8px 0; 
            padding: 8px;
            background: white;
            border-radius: 4px;
            transition: opacity 0.5s ease;
            border-left: 3px solid #007acc;
        }
        .message.community {
            border-left-color: #ff6b35;
        }
        .message.expiring { 
            opacity: 0.6;
            background: #fff8dc;
        }
        .ttl-indicator { 
            font-size: 0.8em; 
            color: #666; 
            float: right; 
        }
        .callsign {
            font-weight: bold;
            color: #007acc;
        }
        .input-area { 
            margin: 20px 0; 
            padding: 20px;
            border: 1px solid #ddd;
            border-radius: 8px;
            background: white;
        }
        .network-status { 
            background: #e8f5e8; 
            padding: 15px; 
            margin: 15px 0;
            border-radius: 8px;
            font-family: monospace;
        }
        .explanation {
            background: #f0f8ff;
            padding: 15px;
            margin: 15px 0;
            border-radius: 8px;
            border-left: 4px solid #007acc;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>fade.repram.io</h1>
        <p><em>Messages that fade away - a global ephemeral chat room</em></p>
        
        <!-- Explanation -->
        <div class="explanation">
            <h3>How it works:</h3>
            <ul>
                <li><strong>No accounts needed</strong> - just type and submit</li>
                <li><strong>Messages spread globally</strong> - takes ~15 minutes to reach all nodes</li>
                <li><strong>Everything disappears</strong> - automatic deletion when TTL expires</li>
                <li><strong>Completely open</strong> - anyone can read, anyone can write</li>
                <li><strong>Distributed network</strong> - no central server to shut down</li>
            </ul>
        </div>
        
        <!-- Live Message Board -->
        <div class="message-board" id="messageBoard">
            <div class="message">
                <span class="content">Welcome to REPRAM! This global message board demonstrates ephemeral distributed storage.</span>
                <span class="ttl-indicator">TTL: 58m</span>
            </div>
            <div class="message community">
                <span class="content"><span class="callsign">[Crypto-73/PNW]</span> Evening net check-in. Network conditions excellent tonight.</span>
                <span class="ttl-indicator">TTL: 2h 15m</span>
            </div>
            <div class="message">
                <span class="content">Testing from Tokyo! Messages automatically replicate worldwide.</span>
                <span class="ttl-indicator">TTL: 45m</span>
            </div>
            <div class="message expiring">
                <span class="content">This message is about to disappear forever...</span>
                <span class="ttl-indicator">TTL: 3m</span>
            </div>
        </div>
        
        <!-- Message Submission -->
        <div class="input-area">
            <h3>Send a Message</h3>
            <textarea 
                id="messageInput" 
                placeholder="Type your message here... (will be visible to everyone globally)"
                maxlength="280" 
                rows="3"
                style="width: 100%; margin-bottom: 10px;"
            ></textarea>
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span>Characters: <span id="charCount">0</span>/280</span>
                <div>
                    <label for="ttlSelect">Expires in:</label>
                    <select id="ttlSelect" style="margin-left: 10px; margin-right: 10px;">
                        <option value="1800">30 minutes</option>
                        <option value="3600" selected>1 hour</option>
                        <option value="21600">6 hours</option>
                        <option value="86400">1 day</option>
                        <option value="604800">1 week</option>
                    </select>
                    <button onclick="submitMessage()" style="padding: 8px 16px;">Send Message</button>
                </div>
            </div>
            <div style="margin-top: 10px; font-size: 0.9em; color: #666;">
                💡 Your message will appear anonymously and spread to nodes worldwide over ~15 minutes
            </div>
        </div>
        
        <!-- Direct Message Lookup -->
        <div class="input-area">
            <h3>Read Specific Message</h3>
            <p style="color: #666; margin-bottom: 10px;">
                Every message gets a unique key. If someone shares a key with you, you can read that specific message:
            </p>
            <div style="display: flex; gap: 10px; align-items: center;">
                <input 
                    type="text" 
                    id="keyInput" 
                    placeholder="Enter message key (e.g., msg_1704123456_abc123)"
                    style="flex: 1; padding: 8px;"
                >
                <button onclick="lookupMessage()" style="padding: 8px 16px;">Lookup</button>
            </div>
            <div id="lookupResult" style="margin-top: 15px;"></div>
        </div>
        
        <!-- Network Status -->
        <div class="network-status">
            <h3>REPRAM Network Status</h3>
            <div><strong>Active Nodes:</strong> <span id="nodeCount">3</span></div>
            <div><strong>Geographic Distribution:</strong></div>
            <div style="margin-left: 20px;">
                🟢 North America: 1 node (last gossip: 2s ago)<br>
                🟢 Europe: 1 node (last gossip: 1s ago)<br>
                🟢 Asia Pacific: 1 node (last gossip: 3s ago)
            </div>
            <div style="margin-top: 10px;">
                <strong>Live Messages:</strong> <span id="messageCount">47</span><br>
                <strong>Messages Expired Today:</strong> <span id="expiredCount">1,234</span><br>
                <strong>Estimated Propagation Time:</strong> 8-15 minutes
            </div>
        </div>
        
        <!-- Technical Info -->
        <div class="input-area">
            <h3>For Developers</h3>
            <p>This demo shows REPRAM's core functionality:</p>
            <ul>
                <li><strong>Pure key-value storage</strong> with automatic TTL expiration</li>
                <li><strong>Gossip protocol replication</strong> across geographically distributed nodes</li>
                <li><strong>Zero authentication</strong> - anyone can read/write data</li>
                <li><strong>Client-side conventions</strong> for optional features (like callsigns)</li>
                <li><strong>No encryption</strong> in demo mode - data is plaintext</li>
            </ul>
            <p>
                <strong>Want to run your own node?</strong> 
                <a href="https://github.com/yourname/repram" target="_blank">Check out the REPRAM repository</a>
            </p>
            <p>
                <strong>Need encryption and compliance features?</strong> 
                The enterprise SDK provides client-side encryption, compliance attestations, and zero-trust architecture.
            </p>
        </div>
    </div>
</body>
</html>
```

#### JavaScript Implementation
```javascript
class RepramDemoClient {
    constructor(nodeUrls) {
        this.nodes = nodeUrls;
        this.currentNode = 0;
        this.websocket = null;
        this.messages = new Map();
        this.init();
    }
    
    async init() {
        await this.connectWebSocket();
        await this.loadRecentMessages();
        this.startMessageRefresh();
        this.startTTLUpdater();
    }
    
    // Connect to REPRAM node for real-time updates
    async connectWebSocket() {
        const wsUrl = this.nodes[this.currentNode].replace('http', 'ws') + '/ws/messages';
        this.websocket = new WebSocket(wsUrl);
        
        this.websocket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'new_message') {
                this.displayMessage(data.key, data.value, data.remaining_ttl);
            } else if (data.type === 'message_expired') {
                this.removeMessage(data.key);
            }
        };
        
        this.websocket.onclose = () => {
            console.log('WebSocket closed, trying next node...');
            this.currentNode = (this.currentNode + 1) % this.nodes.length;
            setTimeout(() => this.connectWebSocket(), 2000);
        };
        
        this.websocket.onerror = (error) => {
            console.log('WebSocket error:', error);
        };
    }
    
    // Submit message to REPRAM network
    async submitMessage(content, ttl) {
        const key = this.generateKey();
        
        try {
            const response = await fetch(`${this.nodes[this.currentNode]}/api/put`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: key,
                    value: content,  // Plain text, no encryption
                    ttl: ttl
                })
            });
            
            if (response.ok) {
                // Show immediate local feedback
                this.displayMessage(key, content, ttl);
                return key;
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            console.error('Failed to submit message:', error);
            // Try next node
            this.currentNode = (this.currentNode + 1) % this.nodes.length;
            throw error;
        }
    }
    
    // Get specific message by key
    async getMessage(key) {
        try {
            const response = await fetch(`${this.nodes[this.currentNode]}/api/get/${encodeURIComponent(key)}`);
            if (response.ok) {
                const data = await response.json();
                return {
                    content: data.value,
                    remaining_ttl: data.remaining_ttl
                };
            } else if (response.status === 404) {
                return null; // Message expired or doesn't exist
            } else {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to get message:', error);
            return null;
        }
    }
    
    // Load recent messages from network
    async loadRecentMessages() {
        try {
            const response = await fetch(`${this.nodes[this.currentNode]}/api/scan/msg_?limit=50`);
            if (response.ok) {
                const messages = await response.json();
                
                // Clear existing messages
                this.messages.clear();
                const board = document.getElementById('messageBoard');
                board.innerHTML = '';
                
                // Display messages sorted by timestamp (newest first)
                messages
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .forEach(item => {
                        this.displayMessage(item.key, item.value, item.remaining_ttl);
                    });
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }
    
    // Generate unique key for new messages
    generateKey() {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substr(2, 9);
        return `msg_${timestamp}_${random}`;
    }
    
    // Parse message format: "content|callsign|location"
    parseMessage(raw) {
        const parts = raw.split('|');
        return {
            content: parts[0] || raw,
            callsign: parts[1] || null,
            location: parts[2] || null
        };
    }
    
    // Display message in the UI
    displayMessage(key, rawMessage, remainingTTL) {
        // Avoid duplicates
        if (this.messages.has(key)) return;
        
        const parsed = this.parseMessage(rawMessage);
        this.messages.set(key, { parsed, remainingTTL, element: null });
        
        const messageDiv = document.createElement('div');
        messageDiv.className = parsed.callsign ? 'message community' : 'message';
        
        let displayContent;
        if (parsed.callsign) {
            displayContent = `<span class="callsign">[${parsed.callsign}${parsed.location ? '/' + parsed.location : ''}]</span> ${this.escapeHtml(parsed.content)}`;
        } else {
            displayContent = this.escapeHtml(parsed.content);
        }
        
        messageDiv.innerHTML = `
            <span class="content">${displayContent}</span>
            <span class="ttl-indicator">TTL: ${this.formatTTL(remainingTTL)}</span>
        `;
        
        // Add expiring class if less than 5 minutes
        if (remainingTTL < 300) {
            messageDiv.classList.add('expiring');
        }
        
        const board = document.getElementById('messageBoard');
        board.insertBefore(messageDiv, board.firstChild);
        
        // Store element reference for updates
        this.messages.get(key).element = messageDiv;
        
        // Limit board size
        while (board.children.length > 100) {
            const lastChild = board.lastChild;
            const lastKey = [...this.messages.entries()]
                .find(([k, v]) => v.element === lastChild)?.[0];
            if (lastKey) this.messages.delete(lastKey);
            board.removeChild(lastChild);
        }
        
        // Auto-scroll to show new messages
        board.scrollTop = 0;
    }
    
    // Remove expired message from UI
    removeMessage(key) {
        const messageData = this.messages.get(key);
        if (messageData && messageData.element) {
            messageData.element.style.opacity = '0';
            messageData.element.style.transform = 'scale(0.95)';
            setTimeout(() => {
                if (messageData.element.parentNode) {
                    messageData.element.parentNode.removeChild(messageData.element);
                }
            }, 500);
        }
        this.messages.delete(key);
    }
    
    // Update TTL displays and handle expiration
    startTTLUpdater() {
        setInterval(() => {
            this.messages.forEach((data, key) => {
                data.remainingTTL -= 1;
                
                if (data.remainingTTL <= 0) {
                    this.removeMessage(key);
                } else {
                    const ttlSpan = data.element?.querySelector('.ttl-indicator');
                    if (ttlSpan) {
                        ttlSpan.textContent = `TTL: ${this.formatTTL(data.remainingTTL)}`;
                    }
                    
                    // Add expiring class when < 5 minutes
                    if (data.remainingTTL < 300 && data.element) {
                        data.element.classList.add('expiring');
                    }
                }
            });
            
            this.updateNetworkStats();
        }, 1000);
    }
    
    // Format TTL for display
    formatTTL(seconds) {
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
        return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
    }
    
    // Update network status display
    async updateNetworkStats() {
        try {
            const response = await fetch(`${this.nodes[this.currentNode]}/api/status`);
            if (response.ok) {
                const status = await response.json();
                document.getElementById('messageCount').textContent = status.total_messages || 0;
                document.getElementById('expiredCount').textContent = status.expired_today || 0;
                document.getElementById('nodeCount').textContent = status.active_nodes || this.nodes.length;
            }
        } catch (error) {
            // Silently fail - network stats are nice-to-have
        }
    }
    
    // Utility functions
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    startMessageRefresh() {
        // Periodic full refresh as backup to WebSocket
        setInterval(() => this.loadRecentMessages(), 60000);
    }
}

// Initialize demo client with multiple nodes for redundancy
const demoClient = new RepramDemoClient([
    'https://demo-us.repram.io',
    'https://demo-eu.repram.io', 
    'https://demo-asia.repram.io'
]);

// UI Event Handlers
async function submitMessage() {
    const messageInput = document.getElementById('messageInput');
    const ttlSelect = document.getElementById('ttlSelect');
    const content = messageInput.value.trim();
    const ttl = parseInt(ttlSelect.value);
    
    if (!content) {
        alert('Please enter a message');
        return;
    }
    
    if (content.includes('|')) {
        alert('Messages cannot contain the | character (reserved for callsign formatting)');
        return;
    }
    
    try {
        const key = await demoClient.submitMessage(content, ttl);
        messageInput.value = '';
        document.getElementById('charCount').textContent = '0';
        
        // Show success feedback
        const button = event.target;
        const originalText = button.textContent;
        button.textContent = 'Sent!';
        button.style.background = '#28a745';
        setTimeout(() => {
            button.textContent = originalText;
            button.style.background = '';
        }, 2000);
        
    } catch (error) {
        alert('Failed to send message. Please try again.');
    }
}

async function lookupMessage() {
    const keyInput = document.getElementById('keyInput');
    const key = keyInput.value.trim();
    
    if (!key) {
        alert('Please enter a message key');
        return;
    }
    
    const resultDiv = document.getElementById('lookupResult');
    resultDiv.innerHTML = '<div style="color: #666;">Looking up message...</div>';
    
    try {
        const message = await demoClient.getMessage(key);
        if (message) {
            const parsed = demoClient.parseMessage(message.content);
            let displayContent;
            
            if (parsed.callsign) {
                displayContent = `<strong>[${parsed.callsign}${parsed.location ? '/' + parsed.location : ''}]</strong> ${demoClient.escapeHtml(parsed.content)}`;
            } else {
                displayContent = demoClient.escapeHtml(parsed.content);
            }
            
            resultDiv.innerHTML = `
                <div style="background: #e8f5e8; padding: 15px; border-radius: 4px; border-left: 4px solid #28a745;">
                    <div style="margin-bottom: 8px;"><strong>Message:</strong></div>
                    <div style="font-style: italic; margin-bottom: 8px;">${displayContent}</div>
                    <div style="font-size: 0.9em; color: #666;">
                        <strong>TTL Remaining:</strong> ${demoClient.formatTTL(message.remaining_ttl)}
                    </div>
                </div>
            `;
        } else {
            resultDiv.innerHTML = `
                <div style="background: #f8d7da; padding: 15px; border-radius: 4px; border-left: 4px solid #dc3545;">
                    <strong>Message not found</strong><br>
                    <span style="font-size: 0.9em;">The message may have expired or the key might be incorrect.</span>
                </div>
            `;
        }
    } catch (error) {
        resultDiv.innerHTML = `
            <div style="background: #f8d7da; padding: 15px; border-radius: 4px; border-left: 4px solid #dc3545;">
                <strong>Error looking up message</strong><br>
                <span style="font-size: 0.9em;">Please check the key and try again.</span>
            </div>
        `;
    }
}

// Character counter
document.addEventListener('DOMContentLoaded', function() {
    const messageInput = document.getElementById('messageInput');
    const charCount = document.getElementById('charCount');
    
    messageInput.addEventListener('input', function() {
        charCount.textContent = this.value.length;
        
        // Warn when approaching limit
        if (this.value.length > 250) {
            charCount.style.color = '#dc3545';
        } else {
            charCount.style.color = '';
        }
    });
    
    // Enter to submit (with Shift+Enter for new lines)
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitMessage();
        }
    });
});
```

### SDK Client Example (Community Features)

#### Community Client Implementation
```go
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"
    "time"
    
    "github.com/yourname/repram-sdk"
)

type CommunityConfig struct {
    Callsign string `yaml:"callsign"`
    Location string `yaml:"location"`
    Nodes    []string `yaml:"nodes"`
}

func main() {
    config := loadConfig()
    client := repram.NewClient(config.Nodes)
    
    fmt.Printf("REPRAM Community Client - Callsign: %s\n", config.Callsign)
    fmt.Printf("Connected to %d nodes\n", len(config.Nodes))
    fmt.Println("Type messages (or 'quit' to exit):")
    
    // Start message listener
    go listenForMessages(client, config.Callsign)
    
    // Handle user input
    scanner := bufio.NewScanner(os.Stdin)
    for scanner.Scan() {
        input := strings.TrimSpace(scanner.Text())
        if input == "quit" {
            break
        }
        if input == "" {
            continue
        }
        
        // Send message with callsign
        sendCommunityMessage(client, input, config)
    }
}

func sendCommunityMessage(client *repram.Client, message string, config CommunityConfig) {
    // Format: "message|callsign|location"
    content := message
    if config.Callsign != "" {
        content = fmt.Sprintf("%s|%s|%s", message, config.Callsign, config.Location)
    }
    
    key := fmt.Sprintf("msg_%d_%s", time.Now().Unix(), generateRandomID())
    err := client.Put(key, content, 7200) // 2 hour TTL
    
    if err != nil {
        fmt.Printf("Error sending message: %v\n", err)
    } else {
        fmt.Printf("Sent: [%s] %s\n", config.Callsign, message)
    }
}

func listenForMessages(client *repram.Client, myCallsign string) {
    subscription := client.Subscribe("msg_*")
    
    for msg := range subscription {
        content, callsign, location := parseMessage(msg.Value)
        
        // Don't show our own messages
        if callsign == myCallsign {
            continue
        }
        
        timestamp := time.Now().Format("15:04")
        if callsign != "" {
            fmt.Printf("[%s] [%s/%s] %s\n", timestamp, callsign, location, content)
        } else {
            fmt.Printf("[%s] [Anonymous] %s\n", timestamp, content)
        }
    }
}

func parseMessage(raw string) (content, callsign, location string) {
    parts := strings.Split(raw, "|")
    content = parts[0]
    if len(parts) >= 3 {
        callsign = parts[1]
        location = parts[2]
    }
    return
}
```

## Network Architecture

### Multi-Region Node Deployment
```yaml
# docker-compose.demo.yml
version: '3.8'

services:
  repram-demo-us:
    image: repram:latest
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      - REPRAM_NODE_REGION=us-east-1
      - REPRAM_BOOTSTRAP_PEERS=demo-eu.repram.io:9090,demo-asia.repram.io:9090
      - REPRAM_PUBLIC_ADDRESS=demo-us.repram.io:9090
      - REPRAM_LOG_LEVEL=info
    volumes:
      - ./config:/etc/repram
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  nginx-frontend:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./frontend:/usr/share/nginx/html
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - repram-demo-us
    restart: unless-stopped
```

### Backend API Extensions
```go
// Additional endpoints for demo functionality

// WebSocket for real-time message updates
func (s *Server) handleMessageWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("WebSocket upgrade failed: %v", err)
        return
    }
    defer conn.Close()
    
    client := &WSClient{
        conn: conn,
        send: make(chan WSMessage, 256),
    }
    
    s.registerWSClient(client)
    defer s.unregisterWSClient(client)
    
    // Send recent messages on connect
    s.sendRecentMessages(client)
    
    // Handle client messages and keep connection alive
    client.run()
}

// Scan messages with prefix and limit
func (s *Server) handleMessageScan(w http.ResponseWriter, r *http.Request) {
    prefix := mux.Vars(r)["prefix"]
    limitStr := r.URL.Query().Get("limit")
    limit := 50 // default
    
    if limitStr != "" {
        if parsedLimit, err := strconv.Atoi(limitStr); err == nil && parsedLimit > 0 {
            limit = parsedLimit
        }
    }
    
    var results []MessageResult
    s.storage.Range(func(key string, entry *StorageEntry) bool {
        if strings.HasPrefix(key, prefix) && !entry.IsExpired() {
            results = append(results, MessageResult{
                Key:          key,
                Value:        string(entry.Value),
                RemainingTTL: int(entry.ExpiresAt.Sub(time.Now()).Seconds()),
                Timestamp:    entry.CreatedAt.Unix(),
            })
        }
        return len(results) < limit
    })
    
    // Sort by creation time (newest first)
    sort.Slice(results, func(i, j int) bool {
        return results[i].Timestamp > results[j].Timestamp
    })
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(results)
}

// Enhanced status with demo-specific metrics
func (s *Server) handleDemoStatus(w http.ResponseWriter, r *http.Request) {
    messageCount := 0
    expiredToday := s.getExpiredTodayCount()
    
    s.storage.Range(func(key string, entry *StorageEntry) bool {
        if strings.HasPrefix(key, "msg_") && !entry.IsExpired() {
            messageCount++
        }
        return true
    })
    
    status := DemoStatusResponse{
        Status:            "healthy",
        TotalMessages:     messageCount,
        ExpiredToday:      expiredToday,
        ActiveNodes:       len(s.peers) + 1,
        WebSocketClients:  len(s.wsClients),
        NetworkHealth:     s.calculateNetworkHealth(),
        UptimeSeconds:     int(time.Since(s.startTime).Seconds()),
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(status)
}

type MessageResult struct {
    Key          string `json:"key"`
    Value        string `json:"value"`
    RemainingTTL int    `json:"remaining_ttl"`
    Timestamp    int64  `json:"timestamp"`
}

type DemoStatusResponse struct {
    Status            string `json:"status"`
    TotalMessages     int    `json:"total_messages"`
    ExpiredToday      int    `json:"expired_today"`
    ActiveNodes       int    `json:"active_nodes"`
    WebSocketClients  int    `json:"websocket_clients"`
    NetworkHealth     string `json:"network_health"`
    UptimeSeconds     int    `json:"uptime_seconds"`
}
```

## Deployment Strategy

### Geographic Distribution
```bash
#!/bin/bash
# deploy-global.sh

# Deploy to multiple regions for true geographic distribution
regions=("us-east-1" "eu-west-1" "ap-southeast-1")

for region in "${regions[@]}"; do
    echo "Deploying to $region..."
    
    # Build and push region-specific configuration
    docker build -t repram-demo:$region \
        --build-arg REGION=$region \
        --build-arg BOOTSTRAP_PEERS="demo-us.repram.io:9090,demo-eu.repram.io:9090,demo-asia.repram.io:9090" \
        .
    
    # Deploy to cloud provider
    case $region in
        "us-east-1")
            deploy_to_aws $region
            ;;
        "eu-west-1") 
            deploy_to_gcp $region
            ;;
        "ap-southeast-1")
            deploy_to_azure $region
            ;;
    esac
done

echo "Global deployment complete!"
echo "Demo available at: https://fade.repram.io"
```

### Monitoring and Alerting
```yaml
# monitoring/docker-compose.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=repram_demo
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./grafana/datasources:/etc/grafana/provisioning/datasources

volumes:
  prometheus_data:
  grafana_data:
```

## Success Metrics

### User Engagement
- **Page Views**: Daily/weekly visits to fade.repram.io
- **Message Submissions**: User-generated content volume
- **Session Duration**: Time spent exploring the demo
- **Message Lookups**: Direct key access usage
- **Return Visits**: Users coming back to check message expiration

### Technical Validation  
- **Network Performance**: Message propagation times across regions
- **Node Availability**: Uptime percentage of demo nodes
- **Auto-Expiration**: Successful TTL enforcement rate
- **Failover**: Client resilience when nodes become unavailable
- **WebSocket Stability**: Real-time update reliability

### Developer Interest
- **Repository Engagement**: GitHub stars, forks, issues
- **Documentation Views**: Developer guide page views  
- **Node Deployments**: Community-run node adoption
- **SDK Downloads**: Client library usage
- **API Usage**: Programmatic interaction with demo nodes

### Community Development
- **Callsign Adoption**: Percentage of messages using community format
- **Regular Users**: People who establish consistent callsigns
- **Geographic Spread**: Diversity of message origins
- **CB Radio Culture**: Formation of regular check-in schedules

## Community Features

### CB Radio Culture Development
The optional callsign system enables organic community formation:

**Regular Nets**:
- Daily check-ins at coordinated times
- Technical discussions about REPRAM deployment
- Propagation testing across geographic regions
- Emergency communication practice

**Message Conventions**:
```
Format: "message|callsign|location"

Examples:
"Evening net, anyone monitoring?|Crypto-73|Pacific Northwest"
"Copy that, signal 5-by-5 here|Tokyo-Drift|Japan" 
"Going QRT for dinner, back in 30|Privacy-Owl|Europe"
"Technical question: what's your average propagation time?|Node-Runner|Midwest"
```

**Community Self-Organization**:
- Voluntary net control stations
- Help for new users ("Elmers")
- Shared troubleshooting knowledge
- Regional coordination

### SDK Ecosystem
Different clients can provide varying levels of community features:

**Basic Web Client**: Anonymous messages only
**Community Client**: Callsign support, message history
**Advanced Client**: Encryption, compliance features, private channels
**Enterprise SDK**: Full REPRAM feature set for business use

## Timeline

### Week 1: Core Implementation
- ✅ Basic message board UI with real-time updates
- ✅ REPRAM client integration (plaintext messages)
- ✅ Message submission and auto-expiration
- ✅ Direct message lookup functionality

### Week 2: Community Features  
- ✅ Callsign parsing and display
- ✅ Community message formatting
- ✅ WebSocket real-time updates
- ✅ Network status dashboard

### Week 3: Multi-Region Deployment
- ✅ Geographic node distribution
- ✅ Cross-region gossip validation
- ✅ Performance optimization
- ✅ Monitoring and alerting setup

### Week 4: Polish and Launch
- ✅ UI/UX improvements and mobile optimization
- ✅ Error handling and graceful degradation
- ✅ Documentation and tutorial content
- ✅ Public launch and community outreach

## Future Enhancements

### Advanced Visualizations
- **Network Map**: Real-time visualization of node locations and message flow
- **Propagation Animation**: Visual representation of gossip protocol in action
- **Expiration Timeline**: Calendar view showing when messages will expire
- **Geographic Heat Map**: Message density by region

### Enhanced Community Features
- **Message Threading**: Optional reply chains using key references
- **Topic Channels**: Prefix-based message categorization
- **User Reputation**: Community-driven callsign verification
- **Event Scheduling**: Coordinated net times and special events

### Technical Demonstrations
- **Live Debugging**: Real-time gossip protocol inspection
- **Performance Testing**: Load testing with community participation
- **Resilience Demo**: Planned node outages showing network healing
- **Compliance Showcase**: Attestation generation in real-time

This demo project perfectly captures REPRAM's essence: a simple, open, ephemeral message board that demonstrates distributed storage without technical barriers. The optional community features provide personality while maintaining architectural purity, creating the perfect foundation for both casual users and serious enterprise adoption.