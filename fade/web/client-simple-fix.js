// REPRAM Fade Client - Ephemeral Message Board
class RepramFadeClient {
    constructor() {
        // Use proxy endpoints to avoid CORS issues
        this.baseURL = ''; // Same origin
        this.messages = new Map();
        this.pollInterval = null;
        this.ttlInterval = null;
        this.connected = false;
        
        // Track expired messages
        this.expiredToday = this.loadExpiredCount();
        
        // Load saved callsign and location
        this.callsign = localStorage.getItem('fade_callsign') || '';
        this.location = localStorage.getItem('fade_location') || '';
        
        // Preview key for next message
        this.previewKey = null;
        
        // Track node information
        this.nodes = [];
        this.lastUsedNode = null;
        this.preferredNode = null; // null means auto/load-balanced
    }
    
    loadExpiredCount() {
        // Load from localStorage with today's date as key
        const today = new Date().toDateString();
        const stored = localStorage.getItem(`fade_expired_${today}`);
        return stored ? parseInt(stored) : 0;
    }
    
    saveExpiredCount() {
        const today = new Date().toDateString();
        localStorage.setItem(`fade_expired_${today}`, this.expiredToday.toString());
        
        // Clean up old dates
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith('fade_expired_') && !key.includes(today)) {
                localStorage.removeItem(key);
            }
        });
    }
    
    saveCallsign(callsign, location) {
        this.callsign = callsign;
        this.location = location;
        localStorage.setItem('fade_callsign', callsign);
        localStorage.setItem('fade_location', location);
    }

    async init() {
        console.log('Initializing REPRAM Fade client...');
        
        // Update node selector labels for clarity
        const select = document.getElementById('nodeSelect');
        if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            // Update labels to show this is routing preference, not direct connection
            select.options[0].text = 'Auto (Round Robin)';
            select.options[1].text = 'Prefer Node 1';
            select.options[2].text = 'Prefer Node 2';
            select.options[3].text = 'Prefer Node 3';
            
            console.log('Remote access via ' + window.location.hostname + ' - using proxy with node preference.');
        }
        
        await this.connectToNode();
        await this.loadRecentMessages();
        this.startPolling();
        this.startTTLUpdater();
        this.updateNetworkStatus();
    }

    async connectToNode() {
        try {
            console.log('Attempting to connect to REPRAM network...');
            const headers = {};
            if (this.preferredNode) {
                headers['X-Preferred-Node'] = this.preferredNode;
            }
            
            const response = await fetch(`${this.baseURL}/api/health`, {
                method: 'GET',
                headers: headers
            });
            
            console.log('Health check response:', response.status);
            
            if (response.ok) {
                this.connected = true;
                console.log('Connected to REPRAM network via proxy');
                this.updateConnectionStatus('connected');
                // Update node status
                await this.updateNodeStatus();
                return;
            } else {
                console.error('Health check failed with status:', response.status);
                this.updateConnectionStatus('error');
            }
        } catch (error) {
            console.error('Failed to connect to REPRAM network:', error);
            this.updateConnectionStatus('error');
        }
        
        this.showError('Unable to connect to REPRAM network. Please try again later.');
    }

    async updateNodeStatus() {
        try {
            if (this.selectedNode) {
                // When directly connected, we only know about this one node
                this.nodes = [{
                    id: `node-${this.selectedNode.split(':').pop()}`,
                    url: this.selectedNode,
                    healthy: this.connected,
                    current: true
                }];
            } else {
                // Use the proxy's node status endpoint
                const response = await fetch(`${this.baseURL}/api/nodes/status`);
                if (response.ok) {
                    this.nodes = await response.json();
                }
            }
            this.updateNetworkDisplay();
        } catch (error) {
            console.error('Failed to fetch node status:', error);
        }
    }

    updateNetworkDisplay() {
        const activeNodes = this.nodes.filter(n => n.healthy).length;
        document.getElementById('currentNode').textContent = `${activeNodes} nodes active`;
        
        // Update a more detailed display if needed
        const nodeList = this.nodes.map(n => 
            `${n.id}: ${n.healthy ? '✓' : '✗'} ${n.current ? '(current)' : ''}`
        ).join(', ');
        console.log('Node status:', nodeList);
    }

    async submitMessage(content, ttl, callsign, location) {
        if (!this.connected) {
            await this.connectToNode();
        }

        // Use the pre-generated key from preview
        const key = this.nextKey || this.generateKey();
        
        // Format message with callsign if provided
        let formattedContent = content;
        if (callsign) {
            formattedContent = location ? `${content}|${callsign}|${location}` : `${content}|${callsign}|`;
        }
        
        try {
            // Using standard data endpoint (no encryption at node level)
            const headers = {
                'Content-Type': 'application/json'
            };
            
            // Add preferred node header if selected
            if (this.preferredNode) {
                headers['X-Preferred-Node'] = this.preferredNode;
            }
            
            // Convert string to base64 bytes for the data endpoint
            const dataBytes = btoa(formattedContent);
            
            const response = await fetch(`${this.baseURL}/api/data/${key}`, {
                method: 'PUT',
                headers: headers,
                body: JSON.stringify({
                    data: dataBytes,  // Base64 encoded string
                    ttl: parseInt(ttl)
                })
            });

            if (response.ok) {
                // Cluster nodes return plain text "OK", not JSON
                const result = await response.text();
                const actualKey = key; // Use the key we sent
                
                // Capture which node handled the request
                const nodeId = response.headers.get('x-repram-node') || 'unknown';
                const nodeUrl = response.headers.get('x-repram-node-url') || '';
                this.lastUsedNode = { id: nodeId, url: nodeUrl };
                
                // Show immediate local feedback with node info
                this.displayMessage(actualKey, formattedContent, ttl, nodeId);
                
                // Clear the nextKey so a new one is generated for the next message
                this.nextKey = null;
                
                // Update node status periodically
                await this.updateNodeStatus();
                
                return actualKey;
            } else {
                const errorText = await response.text();
                console.error('Server error:', errorText);
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            console.error('Failed to submit message:', error);
            throw error;
        }
    }

    async getMessage(key) {
        if (!this.connected) {
            await this.connectToNode();
        }

        try {
            // Using standard data endpoint
            const url = `${this.baseURL}/api/data/${encodeURIComponent(key)}`;
            const response = await fetch(url);
            
            if (response.ok) {
                // Response is raw bytes (base64 encoded in our case)
                const data = await response.arrayBuffer();
                const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
                const content = atob(base64); // Decode back to string
                
                // Capture which node served this
                const nodeId = response.headers.get('x-repram-node') || null;
                
                return {
                    content: content,
                    ttl: 3600, // Default TTL since cluster nodes don't return it
                    remaining_ttl: 3600,
                    nodeId: nodeId
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

    async loadRecentMessages() {
        const board = document.getElementById('messageBoard');
        
        // Clear loading message
        const loading = board.querySelector('.loading');
        if (loading) {
            loading.remove();
        }
        
        if (!this.connected) {
            return;
        }
        
        try {
            // Try to scan for existing messages on the node
            const headers = {};
            if (this.preferredNode) {
                headers['X-Preferred-Node'] = this.preferredNode;
            }
            
            const scanResponse = await fetch(`${this.baseURL}/api/scan`, {
                method: 'GET',
                headers: headers
            });
            
            if (scanResponse.ok) {
                const scanResult = await scanResponse.json();
                console.log('Found keys on node:', scanResult.keys);
                
                // Load messages for discovered keys (limit to recent 20 to avoid overwhelming)
                const keysToLoad = scanResult.keys.slice(-20);
                for (const key of keysToLoad) {
                    if (!this.messages.has(key)) {
                        const message = await this.getMessage(key);
                        if (message) {
                            this.displayMessage(key, message.content, message.remaining_ttl, message.nodeId, true);
                        }
                    }
                }
            } else {
                console.log('Scan not available or failed, messages will appear when created');
            }
            
            // Show welcome message if no messages and no welcome message already exists
            if (this.messages.size === 0 && !board.querySelector('.welcome-message')) {
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'message welcome-message';
                welcomeDiv.style.textAlign = 'center';
                welcomeDiv.style.opacity = '0.7';
                welcomeDiv.innerHTML = `
                    <div class="message-content">
                        <strong>Welcome to FADE</strong><br>
                        Send the first message or use a key to retrieve existing messages.<br>
                        <em>Messages are ephemeral and will fade away after their TTL expires.</em>
                    </div>
                `;
                board.appendChild(welcomeDiv);
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }

    generateKey() {
        // Fun word lists for generating memorable keys
        const adjectives = [
            'quantum', 'electric', 'neon', 'cyber', 'phantom', 'cosmic', 'digital', 
            'spectral', 'holographic', 'virtual', 'glitched', 'synthetic', 'atomic',
            'fractal', 'binary', 'ethereal', 'temporal', 'neural', 'prismatic',
            'indolent', 'zealous', 'cryptic', 'arcane', 'volatile', 'emergent'
        ];
        
        const nouns = [
            'phoenix', 'serpent', 'wraith', 'specter', 'oracle', 'nexus', 'matrix',
            'cipher', 'enigma', 'paradox', 'vortex', 'daemon', 'entity', 'phantom',
            'baboon', 'raven', 'mantis', 'sphinx', 'hydra', 'chimera', 'basilisk',
            'construct', 'artifact', 'anomaly', 'singularity', 'protocol', 'algorithm'
        ];
        
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const timestamp = Date.now() * 1000000; // Convert to nanoseconds (approximate)
        const random = Math.floor(Math.random() * 1000);
        
        return `msg-${adj}-${noun}-${timestamp}${random}`;
    }
    
    generatePreviewKey() {
        // Generate the actual key that will be used
        if (!this.nextKey) {
            this.nextKey = this.generateKey();
        }
        return this.nextKey;
    }

    parseMessage(raw) {
        const parts = raw.split('|');
        return {
            content: parts[0] || raw,
            callsign: parts[1] || null,
            location: parts[2] || null
        };
    }

    displayMessage(key, rawMessage, remainingTTL, nodeId = null, isRetrieved = false) {
        // Avoid duplicates
        if (this.messages.has(key)) return;

        const parsed = this.parseMessage(rawMessage);
        const messageData = {
            parsed,
            remainingTTL: parseInt(remainingTTL),
            element: null,
            timestamp: Date.now(),
            isRetrieved: isRetrieved,
            nodeId: nodeId
        };
        
        this.messages.set(key, messageData);

        const messageDiv = document.createElement('div');
        messageDiv.className = parsed.callsign ? 'message community' : 'message';
        messageDiv.dataset.key = key;

        let displayContent;
        if (parsed.callsign) {
            displayContent = `<span class="callsign">[${parsed.callsign}${parsed.location ? '/' + parsed.location : ''}]</span> ${this.escapeHtml(parsed.content)}`;
        } else {
            displayContent = this.escapeHtml(parsed.content);
        }

        // Show exact TTL for retrieved messages
        const ttlDisplay = isRetrieved ? this.formatTTL(remainingTTL, true) : this.formatTTL(remainingTTL);
        
        const nodeInfo = nodeId ? `<span class="node-indicator" title="Stored on ${nodeId}">[${nodeId}]</span>` : '';
        
        const messageHTML = `
            <div class="message-content">${displayContent}</div>
            <div class="message-meta">
                <span class="message-key" onclick="fadeClient.copyToClipboard('${key}', event)" title="Click to copy key">KEY: ${key}</span>
                ${nodeInfo}
                <span class="ttl-indicator" data-key="${key}" title="Exact TTL: ${this.formatTTL(remainingTTL, true)}">TTL: ${ttlDisplay}</span>
            </div>
        `;

        messageDiv.innerHTML = messageHTML;

        // Add expiring class if less than 5 minutes
        if (remainingTTL < 300) {
            messageDiv.classList.add('expiring');
        }

        const board = document.getElementById('messageBoard');
        
        // Remove loading message if present
        const loading = board.querySelector('.loading');
        if (loading) {
            loading.remove();
        }
        
        // Remove welcome message if present
        const welcome = board.querySelector('.welcome-message');
        if (welcome) {
            welcome.remove();
        }

        // Insert at bottom (oldest first, like a chat)
        board.appendChild(messageDiv);
        
        // Auto-scroll to bottom to show new message
        board.scrollTop = board.scrollHeight;

        // Store element reference
        messageData.element = messageDiv;

        // Limit board size to 100 messages
        while (board.children.length > 100) {
            const lastChild = board.lastChild;
            const lastKey = lastChild.dataset.key;
            if (lastKey) {
                this.messages.delete(lastKey);
            }
            board.removeChild(lastChild);
        }

        // Update message count
        document.getElementById('messageCount').textContent = this.messages.size;
    }

    removeMessage(key) {
        const messageData = this.messages.get(key);
        if (messageData && messageData.element) {
            // Track expired message
            this.expiredToday++;
            this.saveExpiredCount();
            
            // Add expiring animation class
            messageData.element.classList.add('expiring-now');
            
            // Play a glitch sound effect (optional - could be added later)
            // this.playGlitchSound();
            
            // Remove after animation completes (2 seconds)
            setTimeout(() => {
                if (messageData.element.parentNode) {
                    messageData.element.parentNode.removeChild(messageData.element);
                }
                this.messages.delete(key);
                document.getElementById('messageCount').textContent = this.messages.size;
            }, 2000);
        } else {
            this.messages.delete(key);
            document.getElementById('messageCount').textContent = this.messages.size;
        }
        document.getElementById('expiredCount').textContent = this.expiredToday.toLocaleString();
    }

    startPolling() {
        // Poll for new messages every 5 seconds (reduced frequency)
        let scanCounter = 0;
        this.pollInterval = setInterval(async () => {
            // Skip some polls if there are no messages to reduce load
            if (scanCounter % 2 === 0 && this.messages.size === 0) {
                scanCounter++;
                return;
            }
            
            // Rotate through different scanning messages for visual feedback
            const scanMessages = ['SCANNING NETWORK...', 'CHECKING NODES...', 'POLLING MESSAGES...'];
            const scanMsg = scanMessages[scanCounter % scanMessages.length];
            scanCounter++;
            
            this.updateConnectionStatus('scanning');
            document.getElementById('statusText').textContent = scanMsg;
            
            try {
                // Check if node is still healthy
                const headers = {};
                if (this.preferredNode) {
                    headers['X-Preferred-Node'] = this.preferredNode;
                }
                
                const healthResponse = await fetch(`${this.baseURL}/api/health`, { 
                    method: 'GET', 
                    headers: headers,
                    timeout: 2000 
                });
                
                if (!healthResponse.ok) {
                    this.connected = false;
                    this.updateConnectionStatus('error');
                    document.getElementById('messageBoard').innerHTML = '<div class="loading" style="color: #dc3545;">Connection lost. Retrying...</div>';
                    return;
                }
                
                this.connected = true;
                await this.loadRecentMessages();
                // Update network status less frequently  
                if (scanCounter % 3 === 0) {
                    await this.updateNetworkStatus();
                }
                this.updateConnectionStatus('connected');
            } catch (error) {
                console.error('Polling error:', error);
                this.connected = false;
                this.updateConnectionStatus('error');
                document.getElementById('messageBoard').innerHTML = '<div class="loading" style="color: #dc3545;">Connection lost. Retrying...</div>';
            }
        }, 5000); // Increased from 3 to 5 seconds
    }

    updateConnectionStatus(status, nodeId = null) {
        const icon = document.getElementById('statusIcon');
        const text = document.getElementById('statusText');
        const info = document.getElementById('nodeInfo');
        
        switch(status) {
            case 'scanning':
                icon.className = 'status-icon scanning';
                icon.textContent = '◈';
                text.textContent = 'SCANNING NETWORK...';
                break;
            case 'connected':
                icon.className = 'status-icon connected';
                icon.textContent = '◆';
                if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                    text.textContent = 'PROXY MODE';
                } else {
                    text.textContent = 'CONNECTED';
                }
                if (this.preferredNode) {
                    // Show preferred node
                    info.textContent = `[Prefer: ${this.preferredNode}]`;
                } else if (this.lastUsedNode) {
                    info.textContent = `[Last: ${this.lastUsedNode.id}]`;
                }
                break;
            case 'error':
                icon.className = 'status-icon error';
                icon.textContent = '◇';
                text.textContent = 'CONNECTION ERROR';
                info.textContent = '';
                break;
            default:
                icon.className = 'status-icon';
                icon.textContent = '◆';
                text.textContent = 'INITIALIZING...';
                info.textContent = '';
        }
    }

    async switchNode(nodeUrl) {
        if (nodeUrl) {
            // Extract port number for preference
            const port = nodeUrl.split(':').pop();
            this.preferredNode = port;
            console.log(`Setting preferred node to port ${port}`);
            
            // Update status immediately
            document.getElementById('nodeInfo').textContent = `[Prefer: ${port}]`;
        } else {
            // Back to auto/round-robin
            this.preferredNode = null;
            console.log('Switching to auto/round-robin mode');
            document.getElementById('nodeInfo').textContent = '';
        }
        
        // Clear current messages and reload
        this.messages.clear();
        document.getElementById('messageBoard').innerHTML = '<div class="loading">Updating node preference...</div>';
        
        // Reload messages
        await this.loadRecentMessages();
        this.updateConnectionStatus('connected');
    }

    startTTLUpdater() {
        let updateCounter = 0;
        this.ttlInterval = setInterval(() => {
            updateCounter++;
            
            this.messages.forEach((data, key) => {
                data.remainingTTL -= 1;

                if (data.remainingTTL <= 0) {
                    this.removeMessage(key);
                } else {
                    // Only update DOM every 5 seconds for non-critical TTLs to reduce thrashing
                    const shouldUpdateDOM = data.remainingTTL < 300 || updateCounter % 5 === 0;
                    
                    if (shouldUpdateDOM) {
                        const ttlSpan = data.element?.querySelector('.ttl-indicator');
                        if (ttlSpan) {
                            // Update display - show exact time for retrieved messages or under 1 hour
                            const displayTTL = data.isRetrieved ? this.formatTTL(data.remainingTTL, true) : this.formatTTL(data.remainingTTL);
                            ttlSpan.textContent = `TTL: ${displayTTL}`;
                            
                            // Always update the tooltip with exact time
                            ttlSpan.title = `Exact TTL: ${this.formatTTL(data.remainingTTL, true)}`;
                        }
                    }

                    // Add expiring class when < 5 minutes
                    if (data.remainingTTL < 300 && data.element) {
                        data.element.classList.add('expiring');
                    }
                }
            });
        }, 1000);
    }

    formatTTL(seconds, exact = false) {
        if (exact || seconds < 3600) {
            // Show exact time for messages under 1 hour or when exact is requested
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            
            if (hours > 0) {
                return `${hours}h ${minutes}m ${secs}s`;
            } else if (minutes > 0) {
                return `${minutes}m ${secs}s`;
            } else {
                return `${secs}s`;
            }
        }
        
        // Approximate time for display
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        if (seconds < 86400) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
        }
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }

    async updateNetworkStatus() {
        try {
            // Update node status from the server
            await this.updateNodeStatus();
            
            const activeNodes = this.nodes.filter(n => n.healthy).length;
            
            // Update node count
            document.getElementById('nodeCount').textContent = activeNodes.toString();
            
            // Update expired count with real data
            document.getElementById('expiredCount').textContent = this.expiredToday.toLocaleString();
            
            // Update message count
            document.getElementById('messageCount').textContent = this.messages.size;
            
            // Update node health display
            this.updateNodeHealth();
        } catch (error) {
            document.getElementById('nodeCount').textContent = '0';
        }
    }

    updateNodeHealth() {
        const nodeList = document.getElementById('nodeList');
        nodeList.innerHTML = '';
        
        // Display all nodes from the server status
        if (this.nodes.length > 0) {
            this.nodes.forEach(node => {
                const nodeItem = document.createElement('div');
                nodeItem.className = 'node-item';
                const port = node.url.split(':').pop();
                nodeItem.innerHTML = `
                    <span class="node-status ${node.healthy ? 'online' : 'offline'}"></span>
                    <span>${node.id}: localhost:${port} ${node.current ? '(current)' : ''}</span>
                `;
                nodeList.appendChild(nodeItem);
            });
        } else {
            // Fallback to default display
            const nodeItem = document.createElement('div');
            nodeItem.className = 'node-item';
            nodeItem.innerHTML = `
                <span class="node-status ${this.connected ? 'online' : 'offline'}"></span>
                <span>Local Node: localhost:8080</span>
            `;
            nodeList.appendChild(nodeItem);
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showError(message) {
        const board = document.getElementById('messageBoard');
        board.innerHTML = `<div class="loading" style="color: #dc3545;">${message}</div>`;
    }
    
    copyToClipboard(text, event) {
        // Get the element from the passed event
        const element = event ? event.target : document.activeElement;
        
        // Check if we have clipboard API access
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                // Add copied class for CSS animation
                element.classList.add('copied');
                
                // Remove the class after animation completes
                setTimeout(() => {
                    element.classList.remove('copied');
                }, 1500);
            }).catch((err) => {
                console.error('Clipboard API failed:', err);
                this.fallbackCopy(text, element);
            });
        } else {
            // Fallback for non-secure contexts
            this.fallbackCopy(text, element);
        }
    }
    
    fallbackCopy(text, element) {
        // Create a temporary textarea
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-999999px';
        document.body.appendChild(textarea);
        textarea.select();
        
        try {
            document.execCommand('copy');
            element.classList.add('copied');
            setTimeout(() => {
                element.classList.remove('copied');
            }, 1500);
        } catch (err) {
            alert('Copy failed. Please manually copy: ' + text);
        } finally {
            document.body.removeChild(textarea);
        }
    }

    destroy() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
        if (this.ttlInterval) {
            clearInterval(this.ttlInterval);
        }
    }
}

// Initialize client
let fadeClient = null;

document.addEventListener('DOMContentLoaded', async () => {
    fadeClient = new RepramFadeClient();
    await fadeClient.init();
    
    // Set up event listeners
    const messageInput = document.getElementById('messageInput');
    const charCount = document.getElementById('charCount');
    const callsignInput = document.getElementById('callsignInput');
    const locationInput = document.getElementById('locationInput');
    const keyPreview = document.getElementById('keyPreview');
    
    // Load saved callsign and location
    callsignInput.value = fadeClient.callsign;
    locationInput.value = fadeClient.location;
    
    // Update key preview
    function updateKeyPreview() {
        const preview = fadeClient.generatePreviewKey();
        keyPreview.textContent = preview;
    }
    updateKeyPreview();
    
    messageInput.addEventListener('input', function() {
        charCount.textContent = this.value.length;
        
        // Warn when approaching limit
        if (this.value.length > 250) {
            charCount.style.color = '#ff0000';
        } else {
            charCount.style.color = '';
        }
        
        updateKeyPreview();
    });
    
    // Save callsign/location when changed
    callsignInput.addEventListener('change', function() {
        fadeClient.saveCallsign(this.value.toUpperCase(), locationInput.value.toUpperCase());
    });
    
    locationInput.addEventListener('change', function() {
        fadeClient.saveCallsign(callsignInput.value.toUpperCase(), this.value.toUpperCase());
    });
    
    // Enter to submit (with Shift+Enter for new lines)
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitMessage();
        }
    });
});

async function submitMessage() {
    const messageInput = document.getElementById('messageInput');
    const ttlSelect = document.getElementById('ttlSelect');
    const sendButton = document.getElementById('sendButton');
    const callsignInput = document.getElementById('callsignInput');
    const locationInput = document.getElementById('locationInput');
    
    const content = messageInput.value.trim();
    const ttl = ttlSelect.value;
    const callsign = callsignInput.value.trim().toUpperCase();
    const location = locationInput.value.trim().toUpperCase();
    
    if (!content) {
        alert('Please enter a message');
        return;
    }
    
    if (content.includes('|') || callsign.includes('|') || location.includes('|')) {
        alert('Messages, callsigns, and locations cannot contain the | character');
        return;
    }
    
    // Disable button while sending
    sendButton.disabled = true;
    const originalText = sendButton.textContent;
    sendButton.textContent = 'TRANSMITTING...';
    
    try {
        const key = await fadeClient.submitMessage(content, ttl, callsign, location);
        
        // Clear input
        messageInput.value = '';
        document.getElementById('charCount').textContent = '0';
        
        // Generate new key for next message
        fadeClient.nextKey = null;
        const preview = fadeClient.generatePreviewKey();
        document.getElementById('keyPreview').textContent = preview;
        
        // Show success
        sendButton.textContent = 'TRANSMITTED!';
        sendButton.style.background = '#00ff00';
        sendButton.style.color = '#000';
        
        setTimeout(() => {
            sendButton.textContent = originalText;
            sendButton.style.background = '';
            sendButton.style.color = '';
            sendButton.disabled = false;
        }, 2000);
        
    } catch (error) {
        alert('Failed to send message. Please try again.');
        sendButton.textContent = originalText;
        sendButton.disabled = false;
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
    resultDiv.innerHTML = '<div style="color: #888;">Looking up message...</div>';
    
    try {
        const message = await fadeClient.getMessage(key);
        
        if (message) {
            const parsed = fadeClient.parseMessage(message.content);
            let displayContent;
            
            if (parsed.callsign) {
                displayContent = `<strong>[${parsed.callsign}${parsed.location ? '/' + parsed.location : ''}]</strong> ${fadeClient.escapeHtml(parsed.content)}`;
            } else {
                displayContent = fadeClient.escapeHtml(parsed.content);
            }
            
            const nodeInfo = message.nodeId ? ` <span style="color: #ff00ff; font-size: 0.8em;">[from ${message.nodeId}]</span>` : '';
            
            resultDiv.innerHTML = `
                <div class="lookup-success">
                    <div style="margin-bottom: 8px;"><strong>Message found:</strong></div>
                    <div style="font-style: italic; margin-bottom: 8px;">${displayContent}</div>
                    <div style="font-size: 0.9em; color: #00ffff;">
                        <strong>TTL Remaining:</strong> ${fadeClient.formatTTL(message.remaining_ttl, true)}${nodeInfo}
                    </div>
                </div>
            `;
            
            // Also display the message in the main board with exact TTL
            fadeClient.displayMessage(key, message.content, message.remaining_ttl, message.nodeId, true);
        } else {
            resultDiv.innerHTML = `
                <div class="lookup-error">
                    <strong>Message not found</strong><br>
                    <span style="font-size: 0.9em;">The message may have expired or the key might be incorrect.</span>
                </div>
            `;
        }
    } catch (error) {
        resultDiv.innerHTML = `
            <div class="lookup-error">
                <strong>Error looking up message</strong><br>
                <span style="font-size: 0.9em;">Please check the key and try again.</span>
            </div>
        `;
    }
}


// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (fadeClient) {
        fadeClient.destroy();
    }
});