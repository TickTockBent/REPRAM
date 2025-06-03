// Discovery Protocol Simulation
class DiscoverySimulation {
    constructor() {
        this.nodes = new Map();
        this.nodeIdCounter = 1;
        this.autoRunInterval = null;
        this.viewMode = 'tree';
        this.showLatency = true;
        this.animateChanges = true;
        
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
            
            const hasCapacity = potentialParent.children.length < potentialParent.capacity;
            if (!hasCapacity) continue;
            
            const latency = this.calculateLatency(node.location, potentialParent.location);
            candidates.push({ parent: potentialParent, latency });
        }
        
        if (candidates.length === 0) return false;
        
        // Sort by latency (best first)
        candidates.sort((a, b) => a.latency - b.latency);
        
        // Try to attach at deepest level possible
        let bestCandidate = null;
        let maxDepth = -1;
        
        for (const candidate of candidates.slice(0, 5)) { // Consider top 5 by latency
            if (candidate.parent.depth > maxDepth) {
                maxDepth = candidate.parent.depth;
                bestCandidate = candidate;
            }
        }
        
        if (!bestCandidate) {
            bestCandidate = candidates[0];
        }
        
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
        for (const [id, node] of this.nodes) {
            if (!node.isAlive || node.type === 'root' || !node.parent) continue;
            
            const currentLatency = this.calculateLatency(node.location, node.parent.location);
            
            // Find better parent
            let bestParent = null;
            let bestLatency = currentLatency;
            
            for (const [pid, potential] of this.nodes) {
                if (!potential.isAlive || potential === node || potential.capacity === 0) continue;
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
        
        // Draw links
        const link = g.selectAll('.link')
            .data(links)
            .enter().append('g');
        
        link.append('line')
            .attr('class', 'link')
            .attr('x1', d => this.getNodeX(d.source, root))
            .attr('y1', d => this.getNodeY(d.source, root))
            .attr('x2', d => this.getNodeX(d.target, root))
            .attr('y2', d => this.getNodeY(d.target, root));
        
        if (this.showLatency) {
            link.append('text')
                .attr('class', 'link-label')
                .attr('x', d => (this.getNodeX(d.source, root) + this.getNodeX(d.target, root)) / 2)
                .attr('y', d => (this.getNodeY(d.source, root) + this.getNodeY(d.target, root)) / 2)
                .text(d => d.latency + 'ms');
        }
        
        // Draw nodes
        const node = g.selectAll('.node')
            .data(nodes)
            .enter().append('g')
            .attr('class', 'node')
            .attr('transform', d => `translate(${this.getNodeX(d, root)}, ${this.getNodeY(d, root)})`)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        node.append('circle')
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2);
        
        node.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
        
        // Add capacity indicators
        node.filter(d => d.capacity > 0)
            .append('text')
            .attr('class', 'node-label')
            .attr('y', 35)
            .style('font-size', '10px')
            .text(d => `${d.children.length}/${d.capacity}`);
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
        
        // Draw links
        const link = g.selectAll('.link')
            .data(links)
            .enter().append('g');
        
        link.append('line')
            .attr('class', 'link')
            .attr('x1', d => xScale(d.source.location.lon))
            .attr('y1', d => yScale(d.source.location.lat))
            .attr('x2', d => xScale(d.target.location.lon))
            .attr('y2', d => yScale(d.target.location.lat));
        
        // Draw nodes
        const node = g.selectAll('.node')
            .data(nodes)
            .enter().append('g')
            .attr('class', 'node')
            .attr('transform', d => `translate(${xScale(d.location.lon)}, ${yScale(d.location.lat)})`)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        node.append('circle')
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2);
        
        node.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
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
        
        // Position nodes by depth
        nodes.forEach(node => {
            if (node.type === 'root') {
                const rootIndex = Array.from(this.nodes.values())
                    .filter(n => n.type === 'root')
                    .indexOf(node);
                const angle = (rootIndex / 3) * 2 * Math.PI;
                node.x = centerX + Math.cos(angle) * 50;
                node.y = centerY + Math.sin(angle) * 50;
            } else {
                const radius = node.depth * radiusStep;
                const siblings = node.parent.children;
                const index = siblings.indexOf(node);
                const angleStep = (2 * Math.PI) / siblings.length;
                const parentAngle = Math.atan2(node.parent.y - centerY, node.parent.x - centerX);
                const angle = parentAngle + (index - siblings.length / 2) * angleStep * 0.3;
                
                node.x = centerX + Math.cos(angle) * radius;
                node.y = centerY + Math.sin(angle) * radius;
            }
        });
        
        // Draw links
        const link = g.selectAll('.link')
            .data(links)
            .enter().append('g');
        
        link.append('line')
            .attr('class', 'link')
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
        
        // Draw nodes
        const node = g.selectAll('.node')
            .data(nodes)
            .enter().append('g')
            .attr('class', 'node')
            .attr('transform', d => `translate(${d.x}, ${d.y})`)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        node.append('circle')
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2);
        
        node.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
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