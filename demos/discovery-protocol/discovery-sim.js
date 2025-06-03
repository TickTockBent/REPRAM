// Discovery Protocol Simulation
class DiscoverySimulation {
    constructor() {
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
        
        // Initialize root nodes
        this.initializeRootNodes();
        
        // Set up visualization
        this.svg = d3.select('#networkVisualization');
        this.width = 900;
        this.height = 600;
        
        // Set up event handlers
        this.setupEventHandlers();
        
        // Start discovery message animation
        this.startDiscoveryAnimation();
        
        // Initial render
        this.updateVisualization();
        this.updateStats();
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
        document.getElementById('addNodeBtn').addEventListener('click', () => this.addNode());
        document.getElementById('addMultipleBtn').addEventListener('click', () => this.addMultipleNodes(5));
        document.getElementById('stepBtn').addEventListener('click', () => this.runDiscoveryRound());
        document.getElementById('autoRunBtn').addEventListener('click', () => this.toggleAutoRun());
        document.getElementById('resetBtn').addEventListener('click', () => this.resetNetwork());
        
        document.getElementById('viewMode').addEventListener('change', (e) => {
            this.viewMode = e.target.value;
            this.updateVisualization();
        });
        
        document.getElementById('showLatency').addEventListener('change', (e) => {
            this.showLatency = e.target.checked;
            this.updateVisualization();
        });
        
        document.getElementById('animateChanges').addEventListener('change', (e) => {
            this.animateChanges = e.target.checked;
        });
    }
    
    startDiscoveryAnimation() {
        // Animate discovery messages between nodes
        setInterval(() => {
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
        }, 500);
    }
    
    addNode() {
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
        
        // Find best attachment point
        const attached = this.attachNode(node);
        
        if (attached) {
            this.logEvent(`Added ${nodeId} at (${location.lat.toFixed(1)}, ${location.lon.toFixed(1)})`, 'success');
            
            // Trigger discovery messages
            this.triggerDiscoveryMessages(node);
        } else {
            this.nodes.delete(nodeId);
            this.logEvent(`Failed to add ${nodeId} - network full`, 'error');
        }
        
        this.updateVisualization();
        this.updateStats();
    }
    
    addMultipleNodes(count) {
        for (let i = 0; i < count; i++) {
            setTimeout(() => this.addNode(), i * 200);
        }
    }
    
    attachNode(node) {
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
        let maxDepth = -1;
        
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
    }
    
    triggerDiscoveryMessages(node) {
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
        let migrations = 0;
        
        // Check each node for better attachment
        const nodesToCheck = Array.from(this.nodes.values())
            .filter(n => n.isAlive && n.type !== 'root' && n.parent);
        
        for (const node of nodesToCheck) {
            const currentLatency = this.calculateLatency(node.location, node.parent.location);
            
            // Find better parent
            let bestParent = null;
            let bestLatency = currentLatency;
            
            for (const [pid, potential] of this.nodes) {
                if (!potential.isAlive || potential === node || potential.type === 'leaf') continue;
                if (potential.children.length >= potential.capacity) continue;
                if (this.wouldCreateCycle(node, potential)) continue;
                
                const latency = this.calculateLatency(node.location, potential.location);
                
                // Only migrate if improvement > 25%
                if (latency < bestLatency * 0.75) {
                    bestLatency = latency;
                    bestParent = potential;
                }
            }
            
            if (bestParent && bestParent !== node.parent) {
                // Migrate node
                this.migrateNode(node, bestParent);
                migrations++;
                
                const improvement = ((currentLatency - bestLatency) / currentLatency * 100).toFixed(1);
                this.logEvent(`Migrated ${node.id} to ${bestParent.id} (${improvement}% improvement)`, 'success');
            }
        }
        
        if (migrations === 0) {
            this.logEvent('No migrations needed - network is well-organized', 'success');
        } else {
            this.logEvent(`Completed ${migrations} migrations`, 'success');
        }
        
        this.updateVisualization();
        this.updateStats();
    }
    
    migrateNode(node, newParent) {
        // Trigger migration discovery messages
        this.discoveryMessages.push({
            id: Math.random(),
            source: node,
            target: node.parent,
            startTime: Date.now(),
            duration: 1000,
            type: 'leave'
        });
        
        this.discoveryMessages.push({
            id: Math.random(),
            source: node,
            target: newParent,
            startTime: Date.now() + 500,
            duration: 1500,
            type: 'join'
        });
        
        // Remove from old parent
        if (node.parent) {
            node.parent.children = node.parent.children.filter(c => c !== node);
        }
        
        // Attach to new parent
        node.parent = newParent;
        newParent.children.push(node);
        
        // Update depth for node and all descendants
        this.updateDepth(node);
    }
    
    updateDepth(node) {
        if (node.parent) {
            node.depth = node.parent.depth + 1;
        }
        for (const child of node.children) {
            this.updateDepth(child);
        }
    }
    
    wouldCreateCycle(node, potentialParent) {
        // Check if potentialParent is a descendant of node
        let current = potentialParent;
        while (current) {
            if (current === node) return true;
            current = current.parent;
        }
        return false;
    }
    
    removeNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node || node.type === 'root') return;
        
        node.isAlive = false;
        
        // Handle orphaned children
        const orphans = [...node.children];
        node.children = [];
        
        // Remove from parent
        if (node.parent) {
            node.parent.children = node.parent.children.filter(c => c !== node);
        }
        
        // Reattach orphans
        for (const orphan of orphans) {
            orphan.parent = null;
            this.attachNode(orphan);
        }
        
        this.nodes.delete(nodeId);
        this.logEvent(`Removed ${nodeId}`, 'warning');
        
        this.updateVisualization();
        this.updateStats();
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
        
        document.getElementById('totalNodes').textContent = stats.total;
        document.getElementById('rootNodes').textContent = stats.root;
        document.getElementById('trunkNodes').textContent = stats.trunk;
        document.getElementById('branchNodes').textContent = stats.branch;
        document.getElementById('leafNodes').textContent = stats.leaf;
        document.getElementById('avgDepth').textContent = avgDepth;
        document.getElementById('utilization').textContent = utilization + '%';
    }
    
    updateVisualization() {
        this.svg.selectAll('*').remove();
        
        const g = this.svg.append('g');
        
        // Set up zoom
        const zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on('zoom', (event) => {
                g.attr('transform', event.transform);
            });
        
        this.svg.call(zoom);
        
        if (this.viewMode === 'tree') {
            this.renderTreeView(g);
        } else if (this.viewMode === 'geographic') {
            this.renderGeographicView(g);
        } else {
            this.renderRadialView(g);
        }
        
        // Render discovery messages on top
        this.renderDiscoveryMessages(g);
    }
    
    renderDiscoveryMessages(g) {
        const messages = g.selectAll('.discovery-message')
            .data(this.discoveryMessages, d => d.id);
        
        messages.exit().remove();
        
        const messageEnter = messages.enter()
            .append('circle')
            .attr('class', 'discovery-message')
            .attr('r', 3)
            .style('fill', d => {
                if (d.type === 'discovery') return '#00d2ff';
                if (d.type === 'attach' || d.type === 'join') return '#48bb78';
                if (d.type === 'leave') return '#f56565';
                return '#f6ad55';
            })
            .style('opacity', 0.8);
        
        const allMessages = messageEnter.merge(messages);
        
        // Animate messages along paths
        allMessages.each(function(d) {
            const message = d3.select(this);
            const progress = (Date.now() - d.startTime) / d.duration;
            
            if (progress >= 1) return;
            
            let x1, y1, x2, y2;
            
            if (this.viewMode === 'tree') {
                const root = this.getTreeRoot();
                x1 = this.getNodeX(d.source, root);
                y1 = this.getNodeY(d.source, root);
                x2 = this.getNodeX(d.target, root);
                y2 = this.getNodeY(d.target, root);
            } else if (this.viewMode === 'geographic') {
                const xScale = d3.scaleLinear().domain([-180, 180]).range([50, this.width - 50]);
                const yScale = d3.scaleLinear().domain([-90, 90]).range([this.height - 50, 50]);
                x1 = xScale(d.source.location.lon);
                y1 = yScale(d.source.location.lat);
                x2 = xScale(d.target.location.lon);
                y2 = yScale(d.target.location.lat);
            } else {
                x1 = d.source.x || this.width / 2;
                y1 = d.source.y || this.height / 2;
                x2 = d.target.x || this.width / 2;
                y2 = d.target.y || this.height / 2;
            }
            
            const x = x1 + (x2 - x1) * progress;
            const y = y1 + (y2 - y1) * progress;
            
            message
                .attr('cx', x)
                .attr('cy', y)
                .style('opacity', 0.8 * (1 - progress * 0.5));
        }.bind(this));
        
        // Schedule next update
        if (this.discoveryMessages.length > 0) {
            requestAnimationFrame(() => this.renderDiscoveryMessages(g));
        }
    }
    
    renderTreeView(g) {
        const nodes = Array.from(this.nodes.values()).filter(n => n.isAlive);
        const links = [];
        
        // Create links
        nodes.forEach(node => {
            if (node.parent && node.parent.isAlive) {
                links.push({
                    source: node.parent,
                    target: node,
                    latency: this.calculateLatency(node.location, node.parent.location)
                });
            }
        });
        
        // Create hierarchical layout
        const rootNodes = nodes.filter(n => n.type === 'root');
        const hierarchy = { id: 'network', children: rootNodes };
        
        const treeLayout = d3.tree()
            .size([this.width - 100, this.height - 100])
            .separation((a, b) => (a.parent === b.parent ? 1 : 2));
        
        const root = d3.hierarchy(hierarchy, d => d.children || []);
        treeLayout(root);
        
        // Store tree root for message animation
        this.treeRoot = root;
        
        const duration = this.animateChanges ? 750 : 0;
        
        // Draw links
        const link = g.selectAll('.link')
            .data(links, d => `${d.source.id}-${d.target.id}`);
        
        const linkEnter = link.enter().append('g')
            .attr('class', 'link-group');
        
        linkEnter.append('line')
            .attr('class', 'link')
            .attr('x1', d => this.getNodeX(d.source, root))
            .attr('y1', d => this.getNodeY(d.source, root))
            .attr('x2', d => this.getNodeX(d.source, root))
            .attr('y2', d => this.getNodeY(d.source, root));
        
        if (this.showLatency) {
            linkEnter.append('text')
                .attr('class', 'link-label')
                .attr('x', d => this.getNodeX(d.source, root))
                .attr('y', d => this.getNodeY(d.source, root))
                .style('opacity', 0);
        }
        
        // Update links
        const linkUpdate = linkEnter.merge(link);
        
        linkUpdate.select('line')
            .transition()
            .duration(duration)
            .attr('x1', d => this.getNodeX(d.source, root))
            .attr('y1', d => this.getNodeY(d.source, root))
            .attr('x2', d => this.getNodeX(d.target, root))
            .attr('y2', d => this.getNodeY(d.target, root));
        
        if (this.showLatency) {
            linkUpdate.select('text')
                .transition()
                .duration(duration)
                .attr('x', d => (this.getNodeX(d.source, root) + this.getNodeX(d.target, root)) / 2)
                .attr('y', d => (this.getNodeY(d.source, root) + this.getNodeY(d.target, root)) / 2)
                .style('opacity', 1)
                .text(d => d.latency + 'ms');
        }
        
        link.exit()
            .transition()
            .duration(duration)
            .style('opacity', 0)
            .remove();
        
        // Draw nodes
        const node = g.selectAll('.node')
            .data(nodes, d => d.id);
        
        const nodeEnter = node.enter().append('g')
            .attr('class', 'node')
            .attr('transform', d => `translate(${this.getNodeX(d.parent || d, root)}, ${this.getNodeY(d.parent || d, root)})`)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            })
            .on('mouseover', function(event, d) {
                d3.select(this).select('circle')
                    .transition()
                    .duration(200)
                    .attr('r', d => (d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6) * 1.3);
            })
            .on('mouseout', function(event, d) {
                d3.select(this).select('circle')
                    .transition()
                    .duration(200)
                    .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6);
            });
        
        nodeEnter.append('circle')
            .attr('r', 0)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2)
            .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))');
        
        nodeEnter.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .style('opacity', 0)
            .text(d => d.label || d.id);
        
        nodeEnter.filter(d => d.capacity > 0)
            .append('text')
            .attr('class', 'node-label')
            .attr('y', 35)
            .style('font-size', '10px')
            .style('opacity', 0)
            .text(d => `${d.children.length}/${d.capacity}`);
        
        // Update nodes
        const nodeUpdate = nodeEnter.merge(node);
        
        nodeUpdate.transition()
            .duration(duration)
            .delay((d, i) => i * 50)
            .attr('transform', d => `translate(${this.getNodeX(d, root)}, ${this.getNodeY(d, root)})`);
        
        nodeUpdate.select('circle')
            .transition()
            .duration(duration)
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6);
        
        nodeUpdate.selectAll('text')
            .transition()
            .duration(duration)
            .style('opacity', 1);
        
        // Remove nodes
        node.exit()
            .transition()
            .duration(duration)
            .style('opacity', 0)
            .attr('transform', function(d) {
                const angle = Math.random() * Math.PI * 2;
                const distance = 50;
                const x = parseFloat(d3.select(this).attr('transform').split('(')[1]);
                const y = parseFloat(d3.select(this).attr('transform').split(',')[1]);
                return `translate(${x + Math.cos(angle) * distance}, ${y + Math.sin(angle) * distance}) rotate(180)`;
            })
            .remove();
    }
    
    getTreeRoot() {
        return this.treeRoot;
    }
    
    getNodeX(node, root) {
        const found = this.findInHierarchy(root, node);
        return found ? found.x + 50 : 0;
    }
    
    getNodeY(node, root) {
        const found = this.findInHierarchy(root, node);
        return found ? found.y + 50 : 0;
    }
    
    findInHierarchy(hierarchyNode, targetNode) {
        if (hierarchyNode.data === targetNode) {
            return hierarchyNode;
        }
        if (hierarchyNode.children) {
            for (const child of hierarchyNode.children) {
                const found = this.findInHierarchy(child, targetNode);
                if (found) return found;
            }
        }
        return null;
    }
    
    renderGeographicView(g) {
        const nodes = Array.from(this.nodes.values()).filter(n => n.isAlive);
        const links = [];
        
        nodes.forEach(node => {
            if (node.parent && node.parent.isAlive) {
                links.push({
                    source: node.parent,
                    target: node,
                    latency: this.calculateLatency(node.location, node.parent.location)
                });
            }
        });
        
        // Map geographic coordinates to screen
        const xScale = d3.scaleLinear()
            .domain([-180, 180])
            .range([50, this.width - 50]);
        
        const yScale = d3.scaleLinear()
            .domain([-90, 90])
            .range([this.height - 50, 50]);
        
        const duration = this.animateChanges ? 750 : 0;
        
        // Draw links
        const link = g.selectAll('.link')
            .data(links, d => `${d.source.id}-${d.target.id}`);
        
        link.enter().append('line')
            .attr('class', 'link')
            .attr('x1', d => xScale(d.source.location.lon))
            .attr('y1', d => yScale(d.source.location.lat))
            .attr('x2', d => xScale(d.source.location.lon))
            .attr('y2', d => yScale(d.source.location.lat))
            .transition()
            .duration(duration)
            .attr('x2', d => xScale(d.target.location.lon))
            .attr('y2', d => yScale(d.target.location.lat));
        
        link.exit()
            .transition()
            .duration(duration)
            .style('opacity', 0)
            .remove();
        
        // Draw nodes
        const node = g.selectAll('.node')
            .data(nodes, d => d.id);
        
        const nodeEnter = node.enter().append('g')
            .attr('class', 'node')
            .attr('transform', d => `translate(${xScale(d.location.lon)}, ${yScale(d.location.lat)})`)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        nodeEnter.append('circle')
            .attr('r', 0)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2)
            .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))')
            .transition()
            .duration(duration)
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .on('end', function() {
                // Pulse animation for new nodes
                d3.select(this)
                    .transition()
                    .duration(300)
                    .attr('r', d => (d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6) * 1.5)
                    .transition()
                    .duration(300)
                    .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6);
            });
        
        nodeEnter.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .style('opacity', 0)
            .text(d => d.label || d.id)
            .transition()
            .duration(duration)
            .style('opacity', 1);
        
        node.exit()
            .transition()
            .duration(duration)
            .style('opacity', 0)
            .remove();
    }
    
    renderRadialView(g) {
        const nodes = Array.from(this.nodes.values()).filter(n => n.isAlive);
        const links = [];
        
        nodes.forEach(node => {
            if (node.parent && node.parent.isAlive) {
                links.push({
                    source: node.parent,
                    target: node,
                    latency: this.calculateLatency(node.location, node.parent.location)
                });
            }
        });
        
        // Create radial layout
        const centerX = this.width / 2;
        const centerY = this.height / 2;
        const radiusStep = 80;
        
        // Position nodes by depth with rotation animation
        const time = Date.now() * 0.0001;
        nodes.forEach(node => {
            if (node.type === 'root') {
                const rootIndex = Array.from(this.nodes.values())
                    .filter(n => n.type === 'root')
                    .indexOf(node);
                const angle = (rootIndex / 3) * 2 * Math.PI + time;
                node.x = centerX + Math.cos(angle) * 50;
                node.y = centerY + Math.sin(angle) * 50;
            } else {
                const radius = node.depth * radiusStep;
                const siblings = node.parent.children;
                const index = siblings.indexOf(node);
                const angleStep = (2 * Math.PI) / siblings.length;
                const parentAngle = Math.atan2(node.parent.y - centerY, node.parent.x - centerX);
                const angle = parentAngle + (index - siblings.length / 2) * angleStep * 0.3 + time * (0.5 / node.depth);
                
                node.x = centerX + Math.cos(angle) * radius;
                node.y = centerY + Math.sin(angle) * radius;
            }
        });
        
        const duration = this.animateChanges ? 750 : 0;
        
        // Draw links
        const link = g.selectAll('.link')
            .data(links, d => `${d.source.id}-${d.target.id}`);
        
        link.enter().append('line')
            .attr('class', 'link')
            .merge(link)
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
        
        link.exit().remove();
        
        // Draw nodes
        const node = g.selectAll('.node')
            .data(nodes, d => d.id);
        
        const nodeEnter = node.enter().append('g')
            .attr('class', 'node')
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        nodeEnter.append('circle')
            .attr('r', 0)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2)
            .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))')
            .transition()
            .duration(duration)
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6);
        
        nodeEnter.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
        
        const nodeUpdate = nodeEnter.merge(node);
        nodeUpdate.attr('transform', d => `translate(${d.x}, ${d.y})`);
        
        node.exit()
            .transition()
            .duration(duration)
            .style('opacity', 0)
            .remove();
        
        // Continue animation
        if (this.viewMode === 'radial') {
            requestAnimationFrame(() => this.renderRadialView(g));
        }
    }
    
    logEvent(message, type = 'info') {
        const log = document.getElementById('eventLog');
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
    }
}

// Initialize simulation when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.simulation = new DiscoverySimulation();
});