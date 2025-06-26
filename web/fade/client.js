// REPRAM Fade Client - Ephemeral Message Board
class RepramFadeClient {
    constructor() {
        // Use configuration to determine base URL
        this.baseURL = typeof FadeConfig !== 'undefined' ? FadeConfig.getApiBaseURL() : '';
        this.connectionMode = typeof FadeConfig !== 'undefined' ? FadeConfig.connectionMode : 'proxy';
        this.nodes = typeof FadeConfig !== 'undefined' && FadeConfig.getNodes ? FadeConfig.getNodes() : [];
        this.currentNodeIndex = 0;
        
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
        
        // Track node information (override the earlier initialization)
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
        
        // Initialize network status display
        this.initNetworkStatus();
        
        // Update node selector labels based on connection mode
        const select = document.getElementById('nodeSelect');
        const modeLabel = document.getElementById('modeLabel');
        
        if (this.connectionMode === 'direct') {
            // Direct mode - show node selection with actual URLs
            if (select && this.nodes.length >= 3) {
                select.options[0].text = 'Auto (Load Balance)';
                select.options[0].value = '';
                select.options[1].text = 'Node 1 Direct';
                select.options[1].value = this.nodes[0];
                select.options[2].text = 'Node 2 Direct';
                select.options[2].value = this.nodes[1];
                select.options[3].text = 'Node 3 Direct';
                select.options[3].value = this.nodes[2];
            }
            
            if (modeLabel) modeLabel.textContent = 'DIRECT MODE';
            console.log('Direct connection mode - connecting to cluster nodes directly');
        } else {
            // Proxy mode - use port numbers for preference
            if (select) {
                select.options[0].text = 'Auto (Round Robin)';
                select.options[0].value = '';
                select.options[1].text = 'Prefer Node 1';
                select.options[1].value = 'http://localhost:8081';  // This will be used as port preference
                select.options[2].text = 'Prefer Node 2';
                select.options[2].value = 'http://localhost:8082';
                select.options[3].text = 'Prefer Node 3';
                select.options[3].value = 'http://localhost:8083';
            }
            
            if (modeLabel) modeLabel.textContent = 'PROXY MODE';
            console.log('Proxy mode via ' + window.location.hostname + ' - using proxy with node preference.');
        }
        
        await this.connectToNode();
        await this.loadRecentMessages();
        
        // Start periodic node health checks every minute
        setInterval(() => {
            this.checkAllNodes();
        }, 60000);
        this.startPolling();
        this.startTTLUpdater();
        this.checkAllNodes();
    }

    initNetworkStatus() {
        // Initialize all nodes as connecting
        for (let i = 1; i <= 3; i++) {
            this.updateNodeHealthStatus(i, 'connecting', 'Connecting');
        }
        
        // Initialize status bar
        const modeStatus = document.getElementById('modeStatus');
        const currentActivity = document.getElementById('currentActivity');
        if (modeStatus) modeStatus.textContent = 'INITIALIZING...';
        if (currentActivity) currentActivity.textContent = '';
        
        // Initialize statistics
        const nodeCount = document.getElementById('nodeCount');
        const messageCount = document.getElementById('messageCount');
        const expiredCount = document.getElementById('expiredCount');
        const currentNode = document.getElementById('currentNode');
        
        if (nodeCount) nodeCount.textContent = '0';
        if (messageCount) messageCount.textContent = '0';
        if (expiredCount) expiredCount.textContent = this.expiredToday.toString();
        if (currentNode) currentNode.textContent = 'Connecting...';
        
        // Check Discord bridge status periodically
        this.checkDiscordBridge();
        setInterval(() => this.checkDiscordBridge(), 30000); // Check every 30 seconds
    }
    
    async checkDiscordBridge() {
        const bridgeStatus = document.getElementById('bridgeStatus');
        if (!bridgeStatus) return;
        
        try {
            // Try to reach the Discord bridge health endpoint
            const response = await fetch('https://node1.repram.io:8084/health', {
                method: 'GET',
                mode: 'cors'
            });
            
            if (response.ok) {
                const health = await response.json();
                if (health.connected) {
                    bridgeStatus.textContent = 'Online';
                    bridgeStatus.style.color = '#00ff00';
                    
                    // Update with message counts if available
                    if (health.statistics) {
                        const total = health.statistics.messages_from_discord + health.statistics.messages_to_discord;
                        if (total > 0) {
                            bridgeStatus.textContent = `Online (${total} synced)`;
                        }
                    }
                } else {
                    bridgeStatus.textContent = 'Disconnected';
                    bridgeStatus.style.color = '#ff0000';
                }
            } else {
                bridgeStatus.textContent = 'Offline';
                bridgeStatus.style.color = '#ff0000';
            }
        } catch (error) {
            // Bridge not reachable or doesn't have health endpoint yet
            bridgeStatus.textContent = 'Unknown';
            bridgeStatus.style.color = '#ffff00';
        }
    }

    updateNodeHealthStatus(nodeNum, status, statusText) {
        console.log(`*** FIRST updateNodeStatus method called with parameters ***`);
        console.log(`updateNodeStatus called for node ${nodeNum} with status ${status} and text ${statusText}`);
        
        const icon = document.getElementById(`node${nodeNum}Icon`);
        const state = document.getElementById(`node${nodeNum}State`);
        
        console.log(`Looking for elements: node${nodeNum}Icon and node${nodeNum}State`);
        console.log(`Found icon:`, icon);
        console.log(`Found state:`, state);
        
        if (icon) {
            console.log(`Updating icon classes for node ${nodeNum}`);
            // Remove existing status classes
            icon.classList.remove('online', 'connecting', 'offline');
            icon.classList.add(status);
        }
        
        if (state) {
            console.log(`Updating state text for node ${nodeNum} to: ${statusText}`);
            state.textContent = statusText;
        }
        
        console.log(`updateNodeStatus completed for node ${nodeNum}`);
    }

    async checkAllNodes() {
        console.log('=== checkAllNodes() called ===');
        // Simple health check against each node
        const nodeUrls = [
            'https://node1.repram.io',
            'https://node2.repram.io',
            'https://node3.repram.io'
        ];
        
        let onlineCount = 0;
        
        for (let i = 0; i < nodeUrls.length; i++) {
            console.log(`Checking health of ${nodeUrls[i]}...`);
            try {
                const response = await fetch(`${nodeUrls[i]}/health`, {
                    method: 'GET',
                    mode: 'cors'
                });
                
                console.log(`Health check response for ${nodeUrls[i]}: ${response.status}`);
                
                if (response.ok) {
                    console.log(`Node ${i + 1} is online, updating status...`);
                    try {
                        this.updateNodeHealthStatus(i + 1, 'online', 'Online');
                        console.log(`Successfully called updateNodeStatus for node ${i + 1}`);
                    } catch (error) {
                        console.error(`Error calling updateNodeStatus for node ${i + 1}:`, error);
                    }
                    onlineCount++;
                } else {
                    console.log(`Node ${i + 1} is offline (status ${response.status})`);
                    try {
                        this.updateNodeHealthStatus(i + 1, 'offline', 'Offline');
                    } catch (error) {
                        console.error(`Error calling updateNodeStatus for node ${i + 1}:`, error);
                    }
                }
            } catch (error) {
                console.log(`Node ${i + 1} health check failed:`, error);
                this.updateNodeHealthStatus(i + 1, 'offline', 'Offline');
            }
        }
        
        console.log(`Total online nodes: ${onlineCount}`);
        document.getElementById('nodeCount').textContent = onlineCount;
    }

    async connectToNode() {
        try {
            console.log('Attempting to connect to REPRAM network...');
            
            if (this.connectionMode === 'direct' && this.nodes.length > 0) {
                // Direct connection to cluster nodes
                for (let i = 0; i < this.nodes.length; i++) {
                    const nodeUrl = this.nodes[this.currentNodeIndex];
                    try {
                        console.log('Trying direct connection to:', nodeUrl);
                        const response = await fetch(`${nodeUrl}/health`, {
                            method: 'GET',
                            mode: 'cors'
                        });
                        
                        if (response.ok) {
                            this.baseURL = nodeUrl;
                            this.connected = true;
                            this.lastUsedNode = { id: `node-${this.currentNodeIndex+1}`, url: nodeUrl };
                            console.log('Connected to REPRAM network via direct connection:', nodeUrl);
                            
                            // Update current node display
                            const currentNodeDisplay = nodeUrl.replace('https://', '').replace('http://', '');
                            document.getElementById('currentNode').textContent = currentNodeDisplay;
                            
                            this.updateConnectionStatus('connected');
                            await this.checkAllNodes();
                            return;
                        }
                    } catch (error) {
                        console.log('Failed to connect to node:', nodeUrl, error.message);
                    }
                    
                    // Try next node
                    this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodes.length;
                }
                throw new Error('All direct nodes failed');
            } else {
                // Proxy mode
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
                    await this.checkAllNodes();
                    return;
                } else {
                    console.error('Health check failed with status:', response.status);
                    this.updateConnectionStatus('error');
                }
            }
        } catch (error) {
            console.error('Failed to connect to REPRAM network:', error);
            this.updateConnectionStatus('error');
        }
        
        this.showError('Unable to connect to REPRAM network. Please try again later.');
    }

    async updateNodeStatus() {
        try {
            if (this.connectionMode === 'direct') {
                // For direct connections, create status from configured nodes
                this.nodeStatuses = [];
                for (let i = 0; i < this.nodes.length; i++) {
                    const nodeUrl = this.nodes[i];
                    const isCurrentNode = nodeUrl === this.baseURL;
                    this.nodeStatuses.push({
                        id: `node-${i + 1}`,
                        url: nodeUrl,
                        healthy: isCurrentNode ? this.connected : false, // Only know current node status
                        current: isCurrentNode
                    });
                }
            } else if (this.selectedNode) {
                // When directly connected, we only know about this one node
                this.nodeStatuses = [{
                    id: `node-${this.selectedNode.split(':').pop()}`,
                    url: this.selectedNode,
                    healthy: this.connected,
                    current: true
                }];
            } else {
                // Use the proxy's node status endpoint
                const response = await fetch(`${this.baseURL}/api/nodes/status`);
                if (response.ok) {
                    this.nodeStatuses = await response.json();
                }
            }
            this.updateNetworkDisplay();
        } catch (error) {
            console.error('Failed to fetch node status:', error);
        }
    }

    updateNetworkDisplay() {
        const nodes = this.nodeStatuses || [];
        const activeNodes = nodes.filter(n => n.healthy).length;
        
        // Update node count instead of overwriting current node
        const nodeCount = document.getElementById('nodeCount');
        if (nodeCount) nodeCount.textContent = activeNodes.toString();
        
        // Find and display the current node
        const currentNodeFromStatus = nodes.find(n => n.current);
        if (currentNodeFromStatus) {
            const currentNode = document.getElementById('currentNode');
            if (currentNode) currentNode.textContent = currentNodeFromStatus.id;
        }
        
        // Log simplified node status for debugging
        console.log('Network updated - active nodes:', nodes.filter(n => n.healthy).length);
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
            // Using raw data endpoint with TTL in query parameter
            const headers = {
                'Content-Type': 'text/plain'
            };
            
            // Add preferred node header if selected
            if (this.preferredNode) {
                headers['X-Preferred-Node'] = this.preferredNode;
            }
            
            const endpoint = this.connectionMode === 'direct' ? 
                `${this.baseURL}/data/${key}?ttl=${parseInt(ttl)}` : 
                `${this.baseURL}/api/data/${key}?ttl=${parseInt(ttl)}`;
                
            const response = await fetch(endpoint, {
                method: 'PUT',
                headers: headers,
                body: formattedContent  // Send raw text directly
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
            const url = this.connectionMode === 'direct' ? 
                `${this.baseURL}/data/${encodeURIComponent(key)}` : 
                `${this.baseURL}/api/data/${encodeURIComponent(key)}`;
            const response = await fetch(url);
            
            if (response.ok) {
                // Response is raw text data
                const content = await response.text();
                
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
            
            const scanEndpoint = this.connectionMode === 'direct' ? 
                `${this.baseURL}/scan` : 
                `${this.baseURL}/api/scan`;
            const scanResponse = await fetch(scanEndpoint, {
                method: 'GET',
                headers: headers
            });
            
            if (scanResponse.ok) {
                const scanResult = await scanResponse.json();
                console.log('Found keys on node:', scanResult.keys);
                
                // Load messages for discovered keys (limit to recent 20 to avoid overwhelming)
                const keysToLoad = scanResult.keys ? scanResult.keys.slice(-20) : [];
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
            
            // Update activity status less frequently to reduce flickering
            if (scanCounter % 2 === 0) {
                const activities = ['Polling messages...', 'Checking network...', 'Syncing data...'];
                const activity = activities[Math.floor(scanCounter / 2) % activities.length];
                const currentActivity = document.getElementById('currentActivity');
                if (currentActivity) currentActivity.textContent = activity;
            }
            scanCounter++;
            
            try {
                // Check if node is still healthy
                const headers = {};
                let healthEndpoint;
                
                if (this.connectionMode === 'direct') {
                    // In direct mode, use the current baseURL (which may be a specific selected node)
                    healthEndpoint = `${this.baseURL}/health`;
                } else {
                    // In proxy mode, use preferred node header
                    if (this.preferredNode) {
                        headers['X-Preferred-Node'] = this.preferredNode;
                    }
                    healthEndpoint = `${this.baseURL}/api/health`;
                }
                
                const healthResponse = await fetch(healthEndpoint, { 
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
                
                // Update network status and check all nodes periodically  
                if (scanCounter % 6 === 0) {
                    await this.checkAllNodes();
                    const currentActivity = document.getElementById('currentActivity');
                    if (currentActivity) currentActivity.textContent = 'Network operational';
                } else if (scanCounter % 3 === 0) {
                    await this.updateNetworkStatus();
                }
            } catch (error) {
                console.error('Polling error:', error);
                this.connected = false;
                this.updateConnectionStatus('error');
                document.getElementById('messageBoard').innerHTML = '<div class="loading" style="color: #dc3545;">Connection lost. Retrying...</div>';
            }
        }, 5000); // Increased from 3 to 5 seconds
    }

    updateConnectionStatus(status, nodeId = null) {
        const statusIcon = document.getElementById('statusIcon');
        const modeStatus = document.getElementById('modeStatus');
        const currentActivity = document.getElementById('currentActivity');
        
        // Update status icon
        if (statusIcon) {
            statusIcon.className = `status-icon ${status}`;
            switch(status) {
                case 'scanning':
                    statusIcon.textContent = '◈';
                    break;
                case 'connected':
                    statusIcon.textContent = '◆';
                    break;
                case 'error':
                    statusIcon.textContent = '◇';
                    break;
                default:
                    statusIcon.textContent = '◆';
            }
        }
        
        switch(status) {
            case 'scanning':
                if (modeStatus) modeStatus.textContent = 'SCANNING...';
                if (currentActivity) currentActivity.textContent = 'Searching for nodes...';
                break;
            case 'connected':
                if (modeStatus) {
                    if (this.connectionMode === 'direct') {
                        modeStatus.textContent = 'CONNECTED';
                    } else {
                        modeStatus.textContent = 'CONNECTED';
                    }
                }
                if (currentActivity) currentActivity.textContent = 'Network operational';
                break;
            case 'error':
                if (modeStatus) modeStatus.textContent = 'ERROR';
                if (currentActivity) currentActivity.textContent = 'Retrying connection...';
                break;
            default:
                if (modeStatus) modeStatus.textContent = 'INITIALIZING...';
                if (currentActivity) currentActivity.textContent = '';
        }
    }

    async switchNode(nodeUrl) {
        if (nodeUrl) {
            // In direct mode, switch to specific node
            if (this.connectionMode === 'direct') {
                this.baseURL = nodeUrl;
                this.preferredNode = nodeUrl;
                console.log(`Switching to direct node: ${nodeUrl}`);
                
                // Update current node display
                const currentNodeDisplay = nodeUrl.replace('https://', '').replace('http://', '');
                const currentNode = document.getElementById('currentNode');
                if (currentNode) currentNode.textContent = currentNodeDisplay;
                
                // Update activity to show single node mode
                const currentActivity = document.getElementById('currentActivity');
                if (currentActivity) currentActivity.textContent = `Using ${currentNodeDisplay}`;
            } else {
                // In proxy mode, set preferred node header
                const port = nodeUrl.split(':').pop();
                this.preferredNode = port;
                console.log(`Setting preferred node to port ${port}`);
            }
        } else {
            // Back to auto/load-balance mode
            this.preferredNode = null;
            console.log('Switching to auto/load-balance mode');
            
            const currentActivity = document.getElementById('currentActivity');
            if (currentActivity) currentActivity.textContent = 'Load balancing';
        }
        
        // Clear current messages and reload
        this.messages.clear();
        const messageBoard = document.getElementById('messageBoard');
        if (messageBoard) messageBoard.innerHTML = '<div class="loading">Updating node preference...</div>';
        
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

// Add matrix rain effect (subtle)
function createMatrixRain() {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 1;
        opacity: 0.05;
    `;
    document.body.appendChild(canvas);
    
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const chars = 'FADE0101';
    const fontSize = 14;
    const columns = canvas.width / fontSize;
    const drops = [];
    
    for (let i = 0; i < columns; i++) {
        drops[i] = 1;
    }
    
    function draw() {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = '#00ff00';
        ctx.font = fontSize + 'px monospace';
        
        for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(text, i * fontSize, drops[i] * fontSize);
            
            if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                drops[i] = 0;
            }
            
            drops[i]++;
        }
    }
    
    setInterval(draw, 100);
    
    // Resize handler
    window.addEventListener('resize', function() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    });
}

// Initialize client
let fadeClient = null;

document.addEventListener('DOMContentLoaded', async () => {
    fadeClient = new RepramFadeClient();
    await fadeClient.init();
    
    // Start matrix rain after page loads
    setTimeout(createMatrixRain, 2000);
    
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