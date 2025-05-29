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
        await this.connectToNode();
        await this.loadRecentMessages();
        this.startPolling();
        this.startTTLUpdater();
        this.updateNetworkStatus();
    }

    async connectToNode() {
        try {
            console.log('Attempting to connect to REPRAM network...');
            const response = await fetch(`${this.baseURL}/api/health`, {
                method: 'GET'
            });
            
            console.log('Health check response:', response.status);
            
            if (response.ok) {
                this.connected = true;
                console.log('Connected to REPRAM network via proxy');
                document.getElementById('currentNode').textContent = 'Connected';
                return;
            } else {
                console.error('Health check failed with status:', response.status);
            }
        } catch (error) {
            console.error('Failed to connect to REPRAM network:', error);
        }
        
        this.showError('Unable to connect to REPRAM network. Please try again later.');
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
            // Using raw/put endpoint with our own key
            const response = await fetch(`${this.baseURL}/api/raw/put`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    key: key,  // Send our pre-generated key
                    data: formattedContent,
                    ttl: parseInt(ttl)
                })
            });

            if (response.ok) {
                const result = await response.json();
                const actualKey = result.key || key;
                // Show immediate local feedback
                this.displayMessage(actualKey, formattedContent, ttl);
                
                // Clear the nextKey so a new one is generated for the next message
                this.nextKey = null;
                
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
            // Using raw/get endpoint
            const response = await fetch(`${this.baseURL}/api/raw/get/${encodeURIComponent(key)}`);
            
            if (response.ok) {
                const result = await response.json();
                return {
                    content: result.data,
                    ttl: result.ttl || 3600, // Now we get TTL from the response
                    remaining_ttl: result.ttl || 3600
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
            // Scan for messages with "raw-" prefix (messages created by raw node)
            const response = await fetch(`${this.baseURL}/api/raw/scan?prefix=raw-&limit=50`);
            
            if (!response.ok) {
                console.error('Failed to scan messages:', response.status);
                return;
            }
            
            const data = await response.json();
            const keys = data.keys || [];
            
            // Sort by key (which includes timestamp) to get chronological order
            keys.sort((a, b) => a.key.localeCompare(b.key));
            
            // Fetch content for each key
            for (const keyInfo of keys) {
                // Skip if we already have this message
                if (this.messages.has(keyInfo.key)) {
                    continue;
                }
                
                try {
                    const msgResponse = await fetch(`${this.baseURL}/api/raw/get/${encodeURIComponent(keyInfo.key)}`);
                    if (msgResponse.ok) {
                        const msgData = await msgResponse.json();
                        this.displayMessage(keyInfo.key, msgData.data, keyInfo.ttl);
                    }
                } catch (error) {
                    console.error(`Failed to fetch message ${keyInfo.key}:`, error);
                }
            }
            
            // Show welcome message if no messages
            if (this.messages.size === 0) {
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'message';
                welcomeDiv.style.textAlign = 'center';
                welcomeDiv.style.opacity = '0.7';
                welcomeDiv.innerHTML = '<div class="message-content">Be the first to send a message!</div>';
                board.appendChild(welcomeDiv);
            }
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }

    generateKey() {
        // Generate a key that matches the raw node format
        const timestamp = Date.now() * 1000000; // Convert to nanoseconds (approximate)
        const random = Math.floor(Math.random() * 1000); // Add some randomness
        return `msg-${timestamp}${random}`;
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

    displayMessage(key, rawMessage, remainingTTL, isRetrieved = false) {
        // Avoid duplicates
        if (this.messages.has(key)) return;

        const parsed = this.parseMessage(rawMessage);
        const messageData = {
            parsed,
            remainingTTL: parseInt(remainingTTL),
            element: null,
            timestamp: Date.now(),
            isRetrieved: isRetrieved
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
        
        const messageHTML = `
            <div class="message-content">${displayContent}</div>
            <div class="message-meta">
                <span class="message-key" onclick="fadeClient.copyToClipboard('${key}', event)" title="Click to copy key">KEY: ${key}</span>
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
        const welcome = board.querySelector('.message[style*="center"]');
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
        // Poll for new messages every 3 seconds
        this.pollInterval = setInterval(async () => {
            await this.loadRecentMessages();
            this.updateNetworkStatus();
        }, 3000);
    }

    startTTLUpdater() {
        this.ttlInterval = setInterval(() => {
            this.messages.forEach((data, key) => {
                data.remainingTTL -= 1;

                if (data.remainingTTL <= 0) {
                    this.removeMessage(key);
                } else {
                    const ttlSpan = data.element?.querySelector('.ttl-indicator');
                    if (ttlSpan) {
                        // Update display - show exact time for retrieved messages or under 1 hour
                        const displayTTL = data.isRetrieved ? this.formatTTL(data.remainingTTL, true) : this.formatTTL(data.remainingTTL);
                        ttlSpan.textContent = `TTL: ${displayTTL}`;
                        
                        // Always update the tooltip with exact time
                        ttlSpan.title = `Exact TTL: ${this.formatTTL(data.remainingTTL, true)}`;
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
            const response = await fetch(`${this.baseURL}/api/health`);
            const isHealthy = response.ok;
            
            // Update node count
            document.getElementById('nodeCount').textContent = isHealthy ? '1' : '0';
            
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
        
        const regions = [
            { name: 'Local Node', status: this.connected }
        ];
        
        regions.forEach(region => {
            const nodeItem = document.createElement('div');
            nodeItem.className = 'node-item';
            nodeItem.innerHTML = `
                <span class="node-status ${region.status ? 'online' : 'offline'}"></span>
                <span>${region.name}: localhost:8080</span>
            `;
            nodeList.appendChild(nodeItem);
        });
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
            
            resultDiv.innerHTML = `
                <div class="lookup-success">
                    <div style="margin-bottom: 8px;"><strong>Message found:</strong></div>
                    <div style="font-style: italic; margin-bottom: 8px;">${displayContent}</div>
                    <div style="font-size: 0.9em; color: #00ffff;">
                        <strong>TTL Remaining:</strong> ${fadeClient.formatTTL(message.remaining_ttl, true)}
                    </div>
                </div>
            `;
            
            // Also display the message in the main board with exact TTL
            fadeClient.displayMessage(key, message.content, message.remaining_ttl, true);
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