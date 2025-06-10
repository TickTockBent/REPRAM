// Discovery Protocol Simulation
class DiscoverySimulation {
    constructor() {
        console.log('DiscoverySimulation constructor called');
        
        try {
            this.nodes = new Map();
            this.nodeIdCounter = 1;
            this.autoRunInterval = null;
            this.viewMode = 'tree';
            this.showLatency = true;
            this.animateChanges = true;
            this.discoveryMessages = [];
            
            // Capacity limits
            this.capacities = {
                root: 10,
                trunk: 5,
                branch: 10,
                leaf: 0
            };
            
            console.log('Initializing root nodes...');
            this.initializeRootNodes();
            
            console.log('Setting up visualization...');
            this.svg = d3.select('#networkVisualization');
            this.width = 900;
            this.height = 600;
            
            console.log('Setting up event handlers...');
            this.setupEventHandlers();
            
            console.log('Starting discovery animation...');
            this.startDiscoveryAnimation();
            
            console.log('Initial render...');
            this.updateVisualization();
            this.updateStats();
            
            console.log('DiscoverySimulation initialization complete');
        } catch (error) {
            console.error('Error in constructor:', error);
        }
    }
    
    initializeRootNodes() {
        const rootLocations = [
            { name: 'root-us', lat: 40.7128, lon: -74.0060, label: 'US East' },
            { name: 'root-eu', lat: 51.5074, lon: -0.1278, label: 'EU West' },
            { name: 'root-asia', lat: 35.6762, lon: 139.6503, label: 'Asia Pacific' }
        ];
        
        rootLocations.forEach(loc => {
            const node = {
                id: loc.name,
                type: 'root',
                location: { lat: loc.lat, lon: loc.lon },
                label: loc.label,
                parent: null,
                children: [],
                capacity: this.capacities.root,
                depth: 0,
                isAlive: true
            };
            this.nodes.set(loc.name, node);
        });
        
        this.logEvent(`Initialized ${rootLocations.length} root nodes`, 'success');
    }
    
    setupEventHandlers() {
        try {
            console.log('Setting up event handlers...');
            
            const addBtn = document.getElementById('addNodeBtn');
            if (addBtn) {
                addBtn.addEventListener('click', () => {
                    console.log('Add node button clicked!');
                    this.addNode();
                });
                console.log('Add node button handler set');
            } else {
                console.error('addNodeBtn not found!');
            }
            
            const addMultipleBtn = document.getElementById('addMultipleBtn');
            if (addMultipleBtn) {
                addMultipleBtn.addEventListener('click', () => {
                    console.log('Add multiple nodes button clicked!');
                    this.addMultipleNodes(5);
                });
            }
            
            const stepBtn = document.getElementById('stepBtn');
            if (stepBtn) {
                stepBtn.addEventListener('click', () => {
                    console.log('Step button clicked!');
                    this.runDiscoveryRound();
                });
            }
            
            const autoRunBtn = document.getElementById('autoRunBtn');
            if (autoRunBtn) {
                autoRunBtn.addEventListener('click', () => {
                    console.log('Auto run button clicked!');
                    this.toggleAutoRun();
                });
            }
            
            const resetBtn = document.getElementById('resetBtn');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    console.log('Reset button clicked!');
                    this.resetNetwork();
                });
            }
            
            const viewMode = document.getElementById('viewMode');
            if (viewMode) {
                viewMode.addEventListener('change', (e) => {
                    this.viewMode = e.target.value;
                    this.updateVisualization();
                });
            }
            
            const showLatency = document.getElementById('showLatency');
            if (showLatency) {
                showLatency.addEventListener('change', (e) => {
                    this.showLatency = e.target.checked;
                    this.updateVisualization();
                });
            }
            
            const animateChanges = document.getElementById('animateChanges');
            if (animateChanges) {
                animateChanges.addEventListener('change', (e) => {
                    this.animateChanges = e.target.checked;
                });
            }
            
            console.log('Event handlers setup complete');
        } catch (error) {
            console.error('Error setting up event handlers:', error);
        }
    }
    
    startDiscoveryAnimation() {
        setInterval(() => {
            try {
                // Clean up old messages
                this.discoveryMessages = this.discoveryMessages.filter(msg => Date.now() - msg.startTime < msg.duration);
                
                // Add new discovery messages
                const nodes = Array.from(this.nodes.values()).filter(n => n.isAlive);
                if (nodes.length > 1 && Math.random() < 0.3) {
                    const source = nodes[Math.floor(Math.random() * nodes.length)];
                    const target = nodes[Math.floor(Math.random() * nodes.length)];
                    
                    if (source !== target) {
                        this.discoveryMessages.push({
                            id: Math.random(),
                            source: source,
                            target: target,
                            startTime: Date.now(),
                            duration: 2000 + Math.random() * 1000,
                            type: 'discovery'
                        });
                    }
                }
            } catch (error) {
                console.error('Error in discovery animation:', error);
            }
        }, 500);
    }
    
    addNode() {
        try {
            console.log('Adding node...');
            const nodeId = `node-${this.nodeIdCounter++}`;
            
            // Generate random location
            const location = {
                lat: (Math.random() * 160) - 80,  // -80 to 80
                lon: (Math.random() * 340) - 170  // -170 to 170
            };
            
            const node = {
                id: nodeId,
                type: 'leaf',
                location: location,
                label: nodeId,
                parent: null,
                children: [],
                capacity: 0,
                depth: 0,
                isAlive: true
            };
            
            this.nodes.set(nodeId, node);
            console.log('Node created:', nodeId);
            
            // Find best attachment point
            const attached = this.attachNode(node);
            
            if (attached) {
                this.logEvent(`Added ${nodeId} at (${location.lat.toFixed(1)}, ${location.lon.toFixed(1)})`, 'success');
                this.triggerDiscoveryMessages(node);
                console.log('Node attached successfully');
            } else {
                this.nodes.delete(nodeId);
                this.logEvent(`Failed to add ${nodeId} - network full`, 'error');
                console.log('Node attachment failed');
            }
            
            this.updateVisualization();
            this.updateStats();
            console.log('Node addition complete');
        } catch (error) {
            console.error('Error adding node:', error);
        }
    }
    
    addMultipleNodes(count) {
        for (let i = 0; i < count; i++) {
            setTimeout(() => this.addNode(), i * 200);
        }
    }
    
    attachNode(node) {
        try {
            const candidates = [];
            
            // Find all potential parents
            for (const [id, potentialParent] of this.nodes) {
                if (!potentialParent.isAlive || potentialParent === node) continue;
                
                // Check capacity
                const hasCapacity = potentialParent.children.length < potentialParent.capacity;
                if (!hasCapacity) continue;
                
                // Only non-leaf nodes can be parents
                if (potentialParent.type === 'leaf') continue;
                
                const latency = this.calculateLatency(node.location, potentialParent.location);
                candidates.push({ parent: potentialParent, latency });
            }
            
            if (candidates.length === 0) return false;
            
            // Sort by latency (best first)
            candidates.sort((a, b) => a.latency - b.latency);
            
            // Try to attach at deepest level possible
            let bestCandidate = null;
            
            // First, try to find branch nodes (deepest level that can have children)
            const branchCandidates = candidates.filter(c => c.parent.type === 'branch');
            if (branchCandidates.length > 0) {
                bestCandidate = branchCandidates[0];
            } else {
                // If no branches available, try trunk nodes
                const trunkCandidates = candidates.filter(c => c.parent.type === 'trunk');
                if (trunkCandidates.length > 0) {
                    bestCandidate = trunkCandidates[0];
                } else {
                    // Finally, attach to root if necessary
                    const rootCandidates = candidates.filter(c => c.parent.type === 'root');
                    if (rootCandidates.length > 0) {
                        bestCandidate = rootCandidates[0];
                    }
                }
            }
            
            if (!bestCandidate) return false;
            
            // Attach to best parent
            const parent = bestCandidate.parent;
            node.parent = parent;
            parent.children.push(node);
            node.depth = parent.depth + 1;
            
            // Determine node type based on parent
            if (parent.type === 'root') {
                node.type = 'trunk';
                node.capacity = this.capacities.trunk;
            } else if (parent.type === 'trunk') {
                node.type = 'branch';
                node.capacity = this.capacities.branch;
            } else {
                node.type = 'leaf';
                node.capacity = 0;
            }
            
            return true;
        } catch (error) {
            console.error('Error in attachNode:', error);
            return false;
        }
    }
    
    triggerDiscoveryMessages(node) {
        try {
            // Simulate discovery protocol messages
            if (node.parent) {
                // Message to parent
                this.discoveryMessages.push({
                    id: Math.random(),
                    source: node,
                    target: node.parent,
                    startTime: Date.now(),
                    duration: 1500,
                    type: 'attach'
                });
                
                // Response from parent
                setTimeout(() => {
                    this.discoveryMessages.push({
                        id: Math.random(),
                        source: node.parent,
                        target: node,
                        startTime: Date.now(),
                        duration: 1500,
                        type: 'confirm'
                    });
                }, 300);
            }
        } catch (error) {
            console.error('Error triggering discovery messages:', error);
        }
    }
    
    calculateLatency(loc1, loc2) {
        // Haversine formula for distance
        const R = 6371; // Earth radius in km
        const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
        const dLon = (loc2.lon - loc1.lon) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(loc1.lat * Math.PI / 180) * Math.cos(loc2.lat * Math.PI / 180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = R * c;
        
        // Convert to simulated latency (ms)
        return Math.floor(distance / 100); // 100km = 1ms
    }
    
    runDiscoveryRound() {
        this.logEvent('Running discovery round...', 'warning');
        // Simplified for now
        this.logEvent('Discovery round complete', 'success');
    }
    
    toggleAutoRun() {
        const btn = document.getElementById('autoRunBtn');
        if (this.autoRunInterval) {
            clearInterval(this.autoRunInterval);
            this.autoRunInterval = null;
            btn.textContent = 'Auto Run';
            this.logEvent('Auto-run stopped', 'warning');
        } else {
            this.autoRunInterval = setInterval(() => {
                if (Math.random() < 0.7) {
                    this.addNode();
                } else {
                    this.runDiscoveryRound();
                }
            }, 2000);
            btn.textContent = 'Stop Auto';
            this.logEvent('Auto-run started', 'success');
        }
    }
    
    resetNetwork() {
        if (this.autoRunInterval) {
            this.toggleAutoRun();
        }
        
        this.nodes.clear();
        this.nodeIdCounter = 1;
        this.discoveryMessages = [];
        this.initializeRootNodes();
        
        this.updateVisualization();
        this.updateStats();
    }
    
    updateStats() {
        try {
            const stats = {
                total: 0,
                root: 0,
                trunk: 0,
                branch: 0,
                leaf: 0,
                totalCapacity: 0,
                usedCapacity: 0,
                depths: []
            };
            
            for (const [id, node] of this.nodes) {
                if (!node.isAlive) continue;
                
                stats.total++;
                stats[node.type]++;
                
                if (node.capacity > 0) {
                    stats.totalCapacity += node.capacity;
                    stats.usedCapacity += node.children.length;
                }
                
                if (node.type !== 'root') {
                    stats.depths.push(node.depth);
                }
            }
            
            const avgDepth = stats.depths.length > 0 
                ? (stats.depths.reduce((a, b) => a + b, 0) / stats.depths.length).toFixed(2)
                : '0.00';
            
            const utilization = stats.totalCapacity > 0
                ? Math.floor(stats.usedCapacity / stats.totalCapacity * 100)
                : 0;
            
            const totalNodesEl = document.getElementById('totalNodes');
            const rootNodesEl = document.getElementById('rootNodes');
            const trunkNodesEl = document.getElementById('trunkNodes');
            const branchNodesEl = document.getElementById('branchNodes');
            const leafNodesEl = document.getElementById('leafNodes');
            const avgDepthEl = document.getElementById('avgDepth');
            const utilizationEl = document.getElementById('utilization');
            
            if (totalNodesEl) totalNodesEl.textContent = stats.total;
            if (rootNodesEl) rootNodesEl.textContent = stats.root;
            if (trunkNodesEl) trunkNodesEl.textContent = stats.trunk;
            if (branchNodesEl) branchNodesEl.textContent = stats.branch;
            if (leafNodesEl) leafNodesEl.textContent = stats.leaf;
            if (avgDepthEl) avgDepthEl.textContent = avgDepth;
            if (utilizationEl) utilizationEl.textContent = utilization + '%';
        } catch (error) {
            console.error('Error updating stats:', error);
        }
    }
    
    updateVisualization() {
        try {
            if (!this.svg) {
                console.error('SVG element not found');
                return;
            }
            
            this.svg.selectAll('*').remove();
            
            const g = this.svg.append('g');
            
            // Simple tree visualization for now
            const nodes = Array.from(this.nodes.values()).filter(n => n.isAlive);
            
            // Draw nodes
            const node = g.selectAll('.node')
                .data(nodes, d => d.id);
            
            const nodeEnter = node.enter().append('g')
                .attr('class', 'node')
                .attr('transform', (d, i) => `translate(${50 + (i % 5) * 150}, ${50 + Math.floor(i / 5) * 100})`)
                .on('click', (event, d) => {
                    if (d.type !== 'root') {
                        console.log('Removing node:', d.id);
                        this.removeNode(d.id);
                    }
                });
            
            nodeEnter.append('circle')
                .attr('r', d => d.type === 'root' ? 15 : d.type === 'trunk' ? 12 : d.type === 'branch' ? 10 : 8)
                .attr('class', d => `node-${d.type}`)
                .attr('stroke', '#fff')
                .attr('stroke-width', 2);
            
            nodeEnter.append('text')
                .attr('class', 'node-label')
                .attr('y', 25)
                .attr('text-anchor', 'middle')
                .text(d => d.label || d.id);
            
        } catch (error) {
            console.error('Error updating visualization:', error);
        }
    }
    
    removeNode(nodeId) {
        try {
            const node = this.nodes.get(nodeId);
            if (!node || node.type === 'root') return;
            
            this.nodes.delete(nodeId);
            this.logEvent(`Removed ${nodeId}`, 'warning');
            
            this.updateVisualization();
            this.updateStats();
        } catch (error) {
            console.error('Error removing node:', error);
        }
    }
    
    logEvent(message, type = 'info') {
        try {
            const log = document.getElementById('eventLog');
            if (!log) return;
            
            const entry = document.createElement('div');
            entry.className = 'log-entry fade-in';
            
            const time = new Date().toLocaleTimeString();
            entry.innerHTML = `
                <span class="log-time">${time}</span>
                <span class="log-message ${type}">${message}</span>
            `;
            
            log.insertBefore(entry, log.firstChild);
            
            // Keep only last 20 entries
            while (log.children.length > 20) {
                log.removeChild(log.lastChild);
            }
        } catch (error) {
            console.error('Error logging event:', error);
        }
    }
}

// Initialize simulation when page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing DiscoverySimulation...');
    try {
        window.simulation = new DiscoverySimulation();
        console.log('DiscoverySimulation created successfully');
    } catch (error) {
        console.error('Error creating DiscoverySimulation:', error);
    }
});