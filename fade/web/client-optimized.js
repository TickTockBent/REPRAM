// REPRAM Fade Client - Optimized for Performance
class RepramFadeClient {
    constructor() {
        this.baseURL = '';
        this.messages = new Map();
        this.pollInterval = null;
        this.ttlInterval = null;
        this.connected = false;
        
        // Performance optimizations
        this.pendingDOMUpdates = new Set();
        this.batchUpdateTimer = null;
        this.lastScanTime = 0;
        this.scanCooldown = 5000; // 5 second cooldown between scans
        this.requestQueue = [];
        this.isProcessingQueue = false;
        
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
        this.preferredNode = null;
    }
    
    loadExpiredCount() {
        const today = new Date().toDateString();
        const stored = localStorage.getItem(`fade_expired_${today}`);
        return stored ? parseInt(stored) : 0;
    }
    
    saveExpiredCount() {
        const today = new Date().toDateString();
        localStorage.setItem(`fade_expired_${today}`, this.expiredToday.toString());
        
        // Clean up old dates (throttled to avoid frequent localStorage operations)
        if (Math.random() < 0.1) { // Only 10% of the time
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith('fade_expired_') && !key.includes(today)) {
                    localStorage.removeItem(key);
                }
            });
        }
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
            select.options[0].text = 'Auto (Round Robin)';
            select.options[1].text = 'Prefer Node 1';
            select.options[2].text = 'Prefer Node 2';
            select.options[3].text = 'Prefer Node 3';
            
            console.log('Remote access via ' + window.location.hostname + ' - using proxy with node preference.');
        }
        
        await this.connectToNode();
        await this.loadRecentMessages();
        this.startOptimizedPolling();
        this.startOptimizedTTLUpdater();
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
                this.nodes = [{
                    id: `node-${this.selectedNode.split(':').pop()}`,
                    url: this.selectedNode,
                    healthy: this.connected,
                    current: true
                }];
            } else {
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
        
        const nodeList = this.nodes.map(n => 
            `${n.id}: ${n.healthy ? '✓' : '✗'} ${n.current ? '(current)' : ''}`
        ).join(', ');
        console.log('Node status:', nodeList);
    }

    // Optimized message submission with request queuing
    async submitMessage(content, ttl, callsign, location) {
        if (!this.connected) {
            await this.connectToNode();
        }

        const key = this.nextKey || this.generateKey();
        
        let formattedContent = content;
        if (callsign) {
            formattedContent = location ? `${content}|${callsign}|${location}` : `${content}|${callsign}|`;
        }
        
        return this.queueRequest(async () => {
            try {
                const headers = {
                    'Content-Type': 'application/json'
                };
                
                if (this.preferredNode) {
                    headers['X-Preferred-Node'] = this.preferredNode;
                }
                
                const dataBytes = btoa(formattedContent);
                
                const response = await fetch(`${this.baseURL}/api/data/${key}`, {
                    method: 'PUT',
                    headers: headers,
                    body: JSON.stringify({
                        data: dataBytes,
                        ttl: parseInt(ttl)
                    })
                });

                if (response.ok) {
                    const result = await response.text();
                    const actualKey = key;
                    
                    const nodeId = response.headers.get('x-repram-node') || 'unknown';
                    const nodeUrl = response.headers.get('x-repram-node-url') || '';
                    this.lastUsedNode = { id: nodeId, url: nodeUrl };
                    
                    // Use optimized display method
                    this.displayMessageOptimized(actualKey, formattedContent, ttl, nodeId);
                    
                    this.nextKey = null;
                    
                    // Update node status less frequently
                    if (Math.random() < 0.3) { // Only 30% of the time
                        await this.updateNodeStatus();
                    }
                    
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
        });
    }

    // Request queue to prevent overwhelming the server
    async queueRequest(requestFunc) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ requestFunc, resolve, reject });
            this.processRequestQueue();
        });
    }

    async processRequestQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const { requestFunc, resolve, reject } = this.requestQueue.shift();
            
            try {
                const result = await requestFunc();
                resolve(result);
            } catch (error) {
                reject(error);
            }
            
            // Small delay to prevent overwhelming the server
            await new Promise(r => setTimeout(r, 50));
        }

        this.isProcessingQueue = false;
    }

    async getMessage(key) {
        if (!this.connected) {
            await this.connectToNode();
        }

        try {
            const url = `${this.baseURL}/api/data/${encodeURIComponent(key)}`;
            const response = await fetch(url);
            
            if (response.ok) {
                const data = await response.arrayBuffer();
                const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
                const content = atob(base64);
                
                const nodeId = response.headers.get('x-repram-node') || null;
                
                return {
                    content: content,
                    ttl: 3600,
                    remaining_ttl: 3600,
                    nodeId: nodeId
                };
            } else if (response.status === 404) {
                return null;
            } else {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to get message:', error);
            return null;
        }
    }

    // Optimized message loading with batching and throttling
    async loadRecentMessages() {
        const board = document.getElementById('messageBoard');
        
        const loading = board.querySelector('.loading');
        if (loading) {
            loading.remove();
        }
        
        if (!this.connected) {
            return;
        }
        
        // Throttle scan requests
        const now = Date.now();
        if (now - this.lastScanTime < this.scanCooldown) {
            return;
        }
        this.lastScanTime = now;
        
        try {
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
                
                // Load messages in batches to avoid blocking the UI
                const keysToLoad = scanResult.keys.slice(-20);
                await this.loadMessagesBatch(keysToLoad);
            } else {
                console.log('Scan not available or failed, messages will appear when created');
            }
            
            // Show welcome message if no messages and no welcome message already exists
            if (this.messages.size === 0 && !board.querySelector('.welcome-message')) {
                this.showWelcomeMessage();
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }

    // Load messages in batches to prevent UI blocking
    async loadMessagesBatch(keys) {
        const batchSize = 5;
        const batches = [];
        
        for (let i = 0; i < keys.length; i += batchSize) {
            batches.push(keys.slice(i, i + batchSize));
        }
        
        for (const batch of batches) {
            // Process batch with yield to event loop
            await new Promise(resolve => {
                setTimeout(async () => {
                    const promises = batch.map(async key => {
                        if (!this.messages.has(key)) {
                            const message = await this.getMessage(key);
                            if (message) {
                                this.displayMessageOptimized(key, message.content, message.remaining_ttl, message.nodeId, true);
                            }
                        }
                    });
                    
                    await Promise.all(promises);
                    resolve();
                }, 0);
            });
        }
    }

    showWelcomeMessage() {
        const board = document.getElementById('messageBoard');
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

    generateKey() {
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
        const timestamp = Date.now() * 1000000;
        const random = Math.floor(Math.random() * 1000);
        
        return `msg-${adj}-${noun}-${timestamp}${random}`;
    }
    
    generatePreviewKey() {
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

    // Optimized display method with batched DOM updates
    displayMessageOptimized(key, rawMessage, remainingTTL, nodeId = null, isRetrieved = false) {
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

        // Queue DOM update instead of doing it immediately
        this.queueDOMUpdate(() => this.createMessageElement(key, messageData));
    }

    // Batch DOM updates to prevent blocking
    queueDOMUpdate(updateFunc) {
        this.pendingDOMUpdates.add(updateFunc);
        
        if (this.batchUpdateTimer) {
            clearTimeout(this.batchUpdateTimer);
        }
        
        this.batchUpdateTimer = setTimeout(() => {
            this.processPendingDOMUpdates();
        }, 16); // ~60fps
    }

    processPendingDOMUpdates() {
        const updates = Array.from(this.pendingDOMUpdates);
        this.pendingDOMUpdates.clear();
        
        // Use DocumentFragment for efficient batch insertion
        const fragment = document.createDocumentFragment();
        
        updates.forEach(updateFunc => {
            try {
                updateFunc(fragment);
            } catch (error) {
                console.error('DOM update error:', error);
            }
        });
        
        const board = document.getElementById('messageBoard');
        
        // Remove loading and welcome messages
        ['loading', 'welcome-message'].forEach(className => {
            const element = board.querySelector(`.${className}`);
            if (element) element.remove();
        });
        
        // Append all updates at once
        if (fragment.children.length > 0) {
            board.appendChild(fragment);
            
            // Auto-scroll only if user is near bottom
            const isNearBottom = board.scrollTop + board.clientHeight >= board.scrollHeight - 100;
            if (isNearBottom) {
                board.scrollTop = board.scrollHeight;
            }
        }
        
        // Limit board size
        this.limitBoardSize();
        
        // Update counters
        document.getElementById('messageCount').textContent = this.messages.size;
    }

    createMessageElement(key, messageData, fragment) {
        const messageDiv = document.createElement('div');
        messageDiv.className = messageData.parsed.callsign ? 'message community' : 'message';
        messageDiv.dataset.key = key;

        let displayContent;
        if (messageData.parsed.callsign) {
            displayContent = `<span class="callsign">[${messageData.parsed.callsign}${messageData.parsed.location ? '/' + messageData.parsed.location : ''}]</span> ${this.escapeHtml(messageData.parsed.content)}`;
        } else {
            displayContent = this.escapeHtml(messageData.parsed.content);
        }

        const ttlDisplay = messageData.isRetrieved ? this.formatTTL(messageData.remainingTTL, true) : this.formatTTL(messageData.remainingTTL);
        const nodeInfo = messageData.nodeId ? `<span class="node-indicator" title="Stored on ${messageData.nodeId}">[${messageData.nodeId}]</span>` : '';
        
        const messageHTML = `
            <div class="message-content">${displayContent}</div>
            <div class="message-meta">
                <span class="message-key" onclick="fadeClient.copyToClipboard('${key}', event)" title="Click to copy key">KEY: ${key}</span>
                ${nodeInfo}
                <span class="ttl-indicator" data-key="${key}" title="Exact TTL: ${this.formatTTL(messageData.remainingTTL, true)}">TTL: ${ttlDisplay}</span>
            </div>
        `;

        messageDiv.innerHTML = messageHTML;

        if (messageData.remainingTTL < 300) {
            messageDiv.classList.add('expiring');
        }

        messageData.element = messageDiv;
        
        if (fragment) {
            fragment.appendChild(messageDiv);
        } else {
            return messageDiv;
        }
    }

    limitBoardSize() {
        const board = document.getElementById('messageBoard');
        
        while (board.children.length > 100) {
            const firstChild = board.firstChild;
            const firstKey = firstChild.dataset?.key;
            if (firstKey) {
                this.messages.delete(firstKey);
            }
            board.removeChild(firstChild);
        }
    }

    removeMessage(key) {
        const messageData = this.messages.get(key);
        if (messageData && messageData.element) {
            this.expiredToday++;
            this.saveExpiredCount();
            
            messageData.element.classList.add('expiring-now');
            
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

    // Optimized polling with backoff and intelligent intervals
    startOptimizedPolling() {
        let pollCount = 0;
        let consecutiveErrors = 0;
        
        this.pollInterval = setInterval(async () => {
            pollCount++;
            
            // Dynamic interval based on activity and errors
            const baseInterval = 3000;
            const backoffMultiplier = Math.min(consecutiveErrors * 0.5, 3);
            const actualInterval = baseInterval * (1 + backoffMultiplier);
            
            // Skip some polls if there's been no activity
            if (pollCount % 3 === 0 && this.messages.size === 0) {
                return; // Skip this poll
            }
            
            const scanMessages = ['SCANNING NETWORK...', 'CHECKING NODES...', 'POLLING MESSAGES...'];
            const scanMsg = scanMessages[pollCount % scanMessages.length];
            
            this.updateConnectionStatus('scanning');
            document.getElementById('statusText').textContent = scanMsg;
            
            try {
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
                    throw new Error(`Health check failed: ${healthResponse.status}`);
                }
                
                this.connected = true;
                consecutiveErrors = 0;
                
                // Only scan if enough time has passed
                if (Date.now() - this.lastScanTime >= this.scanCooldown) {
                    await this.loadRecentMessages();
                }
                
                // Update network status less frequently
                if (pollCount % 5 === 0) {
                    await this.updateNetworkStatus();
                }
                
                this.updateConnectionStatus('connected');
                
            } catch (error) {
                console.error('Polling error:', error);
                consecutiveErrors++;
                this.connected = false;
                this.updateConnectionStatus('error');
                
                const board = document.getElementById('messageBoard');
                if (!board.querySelector('.loading')) {
                    board.innerHTML = '<div class="loading" style="color: #dc3545;">Connection lost. Retrying...</div>';
                }
            }
        }, 3000);
    }

    // Optimized TTL updater with staggered updates
    startOptimizedTTLUpdater() {
        let updateCounter = 0;
        
        this.ttlInterval = setInterval(() => {
            updateCounter++;
            
            const messagesToUpdate = Array.from(this.messages.entries());
            const batchSize = 10; // Update 10 messages per second
            const startIndex = (updateCounter * batchSize) % messagesToUpdate.length;
            
            // Update messages in batches to spread the load
            for (let i = 0; i < batchSize && i < messagesToUpdate.length; i++) {
                const index = (startIndex + i) % messagesToUpdate.length;
                const [key, data] = messagesToUpdate[index];
                
                data.remainingTTL -= 1;

                if (data.remainingTTL <= 0) {
                    this.removeMessage(key);
                } else {
                    // Only update DOM every 5 seconds for non-critical TTLs
                    const shouldUpdateDOM = data.remainingTTL < 300 || updateCounter % 5 === 0;
                    
                    if (shouldUpdateDOM) {
                        const ttlSpan = data.element?.querySelector('.ttl-indicator');
                        if (ttlSpan) {
                            const displayTTL = data.isRetrieved ? this.formatTTL(data.remainingTTL, true) : this.formatTTL(data.remainingTTL);
                            ttlSpan.textContent = `TTL: ${displayTTL}`;
                            ttlSpan.title = `Exact TTL: ${this.formatTTL(data.remainingTTL, true)}`;
                        }
                    }

                    if (data.remainingTTL < 300 && data.element) {
                        data.element.classList.add('expiring');
                    }
                }
            }
        }, 1000);
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
            const port = nodeUrl.split(':').pop();
            this.preferredNode = port;
            console.log(`Setting preferred node to port ${port}`);
            document.getElementById('nodeInfo').textContent = `[Prefer: ${port}]`;
        } else {
            this.preferredNode = null;
            console.log('Switching to auto/round-robin mode');
            document.getElementById('nodeInfo').textContent = '';
        }
        
        // Clear current messages and reload
        this.messages.clear();
        document.getElementById('messageBoard').innerHTML = '<div class="loading">Updating node preference...</div>';
        
        // Reset scan cooldown
        this.lastScanTime = 0;
        
        await this.loadRecentMessages();
        this.updateConnectionStatus('connected');
    }

    formatTTL(seconds, exact = false) {
        if (exact || seconds < 3600) {
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
            await this.updateNodeStatus();
            
            const activeNodes = this.nodes.filter(n => n.healthy).length;
            document.getElementById('nodeCount').textContent = activeNodes.toString();
            document.getElementById('expiredCount').textContent = this.expiredToday.toLocaleString();
            document.getElementById('messageCount').textContent = this.messages.size;
            
            this.updateNodeHealth();
        } catch (error) {
            document.getElementById('nodeCount').textContent = '0';
        }
    }

    updateNodeHealth() {
        const nodeList = document.getElementById('nodeList');
        nodeList.innerHTML = '';
        
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
        const element = event ? event.target : document.activeElement;
        
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                element.classList.add('copied');
                setTimeout(() => {
                    element.classList.remove('copied');
                }, 1500);
            }).catch((err) => {
                console.error('Clipboard API failed:', err);
                this.fallbackCopy(text, element);
            });
        } else {
            this.fallbackCopy(text, element);
        }
    }
    
    fallbackCopy(text, element) {
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
        if (this.batchUpdateTimer) {
            clearTimeout(this.batchUpdateTimer);
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
        
        if (this.value.length > 250) {
            charCount.style.color = '#ff0000';
        } else {
            charCount.style.color = '';
        }
        
        updateKeyPreview();
    });
    
    callsignInput.addEventListener('change', function() {
        fadeClient.saveCallsign(this.value.toUpperCase(), locationInput.value.toUpperCase());
    });
    
    locationInput.addEventListener('change', function() {
        fadeClient.saveCallsign(callsignInput.value.toUpperCase(), this.value.toUpperCase());
    });
    
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
        
        messageInput.value = '';
        document.getElementById('charCount').textContent = '0';
        
        fadeClient.nextKey = null;
        const preview = fadeClient.generatePreviewKey();
        document.getElementById('keyPreview').textContent = preview;
        
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
            
            fadeClient.displayMessageOptimized(key, message.content, message.remaining_ttl, message.nodeId, true);
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