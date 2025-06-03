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
            const oldMode = this.viewMode;
            this.viewMode = e.target.value;
            
            // If animations are enabled, fade out then fade in
            if (this.animateChanges) {
                const g = this.svg.select('g.main-group');
                g.transition()
                    .duration(300)
                    .style('opacity', 0)
                    .on('end', () => {
                        this.updateVisualization();
                        g.transition()
                            .duration(300)
                            .style('opacity', 1);
                    });
            } else {
                this.updateVisualization();
            }
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
            
            // IMPORTANT: Leaf nodes cannot attach to root nodes
            if (node.type === 'leaf' && potentialParent.type === 'root') continue;
            
            // Also prevent creating cycles where a leaf would become parent of non-leaf
            if (potentialParent.type === 'leaf') continue;
            
            const latency = this.calculateLatency(node.location, potentialParent.location);
            candidates.push({ parent: potentialParent, latency });
        }
        
        if (candidates.length === 0) return false;
        
        // Sort by latency (best first)
        candidates.sort((a, b) => a.latency - b.latency);
        
        // Try to attach at deepest level possible (but respect hierarchy)
        let bestCandidate = null;
        let maxDepth = -1;
        
        for (const candidate of candidates.slice(0, 5)) { // Consider top 5 by latency
            // Ensure proper hierarchy: Root -> Trunk -> Branch -> Leaf
            if (node.type === 'leaf' && candidate.parent.type === 'root') continue;
            
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
        // Instead of removing everything, we'll update existing elements
        let g = this.svg.select('g.main-group');
        
        if (g.empty()) {
            // First time setup
            g = this.svg.append('g').attr('class', 'main-group');
            
            // Set up zoom
            const zoom = d3.zoom()
                .scaleExtent([0.1, 4])
                .on('zoom', (event) => {
                    g.attr('transform', event.transform);
                });
            
            this.svg.call(zoom);
        }
        
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
                    id: `${node.parent.id}-${node.id}`,
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
        
        // Calculate positions for all nodes
        nodes.forEach(node => {
            const hierarchyNode = this.findInHierarchy(root, node);
            if (hierarchyNode) {
                node.targetX = hierarchyNode.x + 50;
                node.targetY = hierarchyNode.y + 50;
            } else {
                // Fallback position for orphaned nodes
                node.targetX = this.width / 2;
                node.targetY = this.height / 2;
            }
        });
        
        // Update links with D3 join pattern
        const linkGroup = g.selectAll('g.link-group')
            .data(links, d => d.id);
        
        // Exit - remove old links
        linkGroup.exit()
            .transition()
            .duration(this.animateChanges ? 500 : 0)
            .style('opacity', 0)
            .remove();
        
        // Enter - add new links
        const linkEnter = linkGroup.enter()
            .append('g')
            .attr('class', 'link-group')
            .style('opacity', 0);
        
        linkEnter.append('line')
            .attr('class', 'link')
            .attr('x1', d => d.source.targetX || 0)
            .attr('y1', d => d.source.targetY || 0)
            .attr('x2', d => d.source.targetX || 0)
            .attr('y2', d => d.source.targetY || 0);
        
        if (this.showLatency) {
            linkEnter.append('text')
                .attr('class', 'link-label')
                .attr('x', d => d.source.targetX || 0)
                .attr('y', d => d.source.targetY || 0)
                .text(d => d.latency + 'ms');
        }
        
        // Update - merge enter and update selections
        const linkUpdate = linkEnter.merge(linkGroup);
        
        linkUpdate.transition()
            .duration(this.animateChanges ? 750 : 0)
            .style('opacity', 1)
            .select('line')
            .attr('x1', d => d.source.targetX)
            .attr('y1', d => d.source.targetY)
            .attr('x2', d => d.target.targetX)
            .attr('y2', d => d.target.targetY);
        
        if (this.showLatency) {
            linkUpdate.select('text')
                .transition()
                .duration(this.animateChanges ? 750 : 0)
                .attr('x', d => (d.source.targetX + d.target.targetX) / 2)
                .attr('y', d => (d.source.targetY + d.target.targetY) / 2);
        }
        
        // Update nodes with D3 join pattern
        const nodeGroup = g.selectAll('g.node-group')
            .data(nodes, d => d.id);
        
        // Exit - remove old nodes
        nodeGroup.exit()
            .transition()
            .duration(this.animateChanges ? 500 : 0)
            .style('opacity', 0)
            .attr('transform', d => `translate(${d.targetX || 0}, ${d.targetY || 0}) scale(0)`)
            .remove();
        
        // Enter - add new nodes
        const nodeEnter = nodeGroup.enter()
            .append('g')
            .attr('class', 'node-group')
            .attr('transform', d => `translate(${d.targetX || this.width/2}, ${d.targetY || this.height/2}) scale(0)`)
            .style('opacity', 0)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        nodeEnter.append('circle')
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2);
        
        nodeEnter.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
        
        // Add capacity indicators for non-leaf nodes
        nodeEnter.filter(d => d.capacity > 0)
            .append('text')
            .attr('class', 'node-capacity')
            .attr('y', 35)
            .style('font-size', '10px');
        
        // Update - merge enter and update selections
        const nodeUpdate = nodeEnter.merge(nodeGroup);
        
        // Animate to new positions
        nodeUpdate.transition()
            .duration(this.animateChanges ? 750 : 0)
            .delay((d, i) => this.animateChanges ? i * 10 : 0)
            .style('opacity', 1)
            .attr('transform', d => `translate(${d.targetX}, ${d.targetY}) scale(1)`);
        
        // Update capacity text
        nodeUpdate.select('.node-capacity')
            .text(d => `${d.children.length}/${d.capacity}`);
        
        // Add some fun animations on hover
        if (this.animateChanges) {
            nodeUpdate
                .on('mouseenter', function(event, d) {
                    d3.select(this)
                        .transition()
                        .duration(200)
                        .attr('transform', `translate(${d.targetX}, ${d.targetY}) scale(1.2)`);
                })
                .on('mouseleave', function(event, d) {
                    d3.select(this)
                        .transition()
                        .duration(200)
                        .attr('transform', `translate(${d.targetX}, ${d.targetY}) scale(1)`);
                });
        }
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
                    id: `${node.parent.id}-${node.id}`,
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
        
        // Update links with D3 join pattern
        const linkGroup = g.selectAll('g.link-group')
            .data(links, d => d.id);
        
        linkGroup.exit()
            .transition()
            .duration(this.animateChanges ? 500 : 0)
            .style('opacity', 0)
            .remove();
        
        const linkEnter = linkGroup.enter()
            .append('g')
            .attr('class', 'link-group')
            .style('opacity', 0);
        
        linkEnter.append('line')
            .attr('class', 'link')
            .attr('x1', d => xScale(d.source.location.lon))
            .attr('y1', d => yScale(d.source.location.lat))
            .attr('x2', d => xScale(d.source.location.lon))
            .attr('y2', d => yScale(d.source.location.lat));
        
        const linkUpdate = linkEnter.merge(linkGroup);
        
        linkUpdate.transition()
            .duration(this.animateChanges ? 750 : 0)
            .style('opacity', 1)
            .select('line')
            .attr('x1', d => xScale(d.source.location.lon))
            .attr('y1', d => yScale(d.source.location.lat))
            .attr('x2', d => xScale(d.target.location.lon))
            .attr('y2', d => yScale(d.target.location.lat));
        
        // Update nodes with D3 join pattern
        const nodeGroup = g.selectAll('g.node-group')
            .data(nodes, d => d.id);
        
        nodeGroup.exit()
            .transition()
            .duration(this.animateChanges ? 500 : 0)
            .style('opacity', 0)
            .attr('transform', d => `translate(${xScale(d.location.lon)}, ${yScale(d.location.lat)}) scale(0)`)
            .remove();
        
        const nodeEnter = nodeGroup.enter()
            .append('g')
            .attr('class', 'node-group')
            .attr('transform', d => `translate(${xScale(d.location.lon)}, ${yScale(d.location.lat)}) scale(0)`)
            .style('opacity', 0)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        nodeEnter.append('circle')
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2);
        
        nodeEnter.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
        
        const nodeUpdate = nodeEnter.merge(nodeGroup);
        
        nodeUpdate.transition()
            .duration(this.animateChanges ? 750 : 0)
            .delay((d, i) => this.animateChanges ? i * 10 : 0)
            .style('opacity', 1)
            .attr('transform', d => `translate(${xScale(d.location.lon)}, ${yScale(d.location.lat)}) scale(1)`);
        
        // Add pulse animation for new nodes
        if (this.animateChanges) {
            nodeEnter.select('circle')
                .transition()
                .duration(1000)
                .attr('r', d => (d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6) * 1.5)
                .transition()
                .duration(500)
                .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6);
        }
    }
    
    renderRadialView(g) {
        const nodes = Array.from(this.nodes.values()).filter(n => n.isAlive);
        const links = [];
        
        nodes.forEach(node => {
            if (node.parent && node.parent.isAlive) {
                links.push({
                    id: `${node.parent.id}-${node.id}`,
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
                node.targetX = centerX + Math.cos(angle) * 50;
                node.targetY = centerY + Math.sin(angle) * 50;
            } else {
                const radius = node.depth * radiusStep;
                const siblings = node.parent.children;
                const index = siblings.indexOf(node);
                const angleStep = (2 * Math.PI) / siblings.length;
                const parentAngle = Math.atan2(node.parent.targetY - centerY, node.parent.targetX - centerX);
                const angle = parentAngle + (index - siblings.length / 2) * angleStep * 0.3;
                
                node.targetX = centerX + Math.cos(angle) * radius;
                node.targetY = centerY + Math.sin(angle) * radius;
            }
        });
        
        // Update links with D3 join pattern
        const linkGroup = g.selectAll('g.link-group')
            .data(links, d => d.id);
        
        linkGroup.exit()
            .transition()
            .duration(this.animateChanges ? 500 : 0)
            .style('opacity', 0)
            .remove();
        
        const linkEnter = linkGroup.enter()
            .append('g')
            .attr('class', 'link-group')
            .style('opacity', 0);
        
        linkEnter.append('line')
            .attr('class', 'link')
            .attr('x1', d => d.source.targetX || centerX)
            .attr('y1', d => d.source.targetY || centerY)
            .attr('x2', d => d.source.targetX || centerX)
            .attr('y2', d => d.source.targetY || centerY);
        
        const linkUpdate = linkEnter.merge(linkGroup);
        
        linkUpdate.transition()
            .duration(this.animateChanges ? 750 : 0)
            .style('opacity', 1)
            .select('line')
            .attr('x1', d => d.source.targetX)
            .attr('y1', d => d.source.targetY)
            .attr('x2', d => d.target.targetX)
            .attr('y2', d => d.target.targetY);
        
        // Update nodes with D3 join pattern
        const nodeGroup = g.selectAll('g.node-group')
            .data(nodes, d => d.id);
        
        nodeGroup.exit()
            .transition()
            .duration(this.animateChanges ? 500 : 0)
            .style('opacity', 0)
            .attr('transform', d => `translate(${d.targetX || centerX}, ${d.targetY || centerY}) scale(0) rotate(360)`)
            .remove();
        
        const nodeEnter = nodeGroup.enter()
            .append('g')
            .attr('class', 'node-group')
            .attr('transform', d => `translate(${centerX}, ${centerY}) scale(0)`)
            .style('opacity', 0)
            .on('click', (event, d) => {
                if (d.type !== 'root') {
                    this.removeNode(d.id);
                }
            });
        
        nodeEnter.append('circle')
            .attr('r', d => d.type === 'root' ? 12 : d.type === 'trunk' ? 10 : d.type === 'branch' ? 8 : 6)
            .attr('class', d => `node-${d.type}`)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2);
        
        nodeEnter.append('text')
            .attr('class', 'node-label')
            .attr('y', 20)
            .text(d => d.label || d.id);
        
        const nodeUpdate = nodeEnter.merge(nodeGroup);
        
        // Animate nodes spiraling out from center
        nodeUpdate.transition()
            .duration(this.animateChanges ? 1000 : 0)
            .delay((d, i) => this.animateChanges ? d.depth * 100 : 0)
            .style('opacity', 1)
            .attr('transform', d => `translate(${d.targetX}, ${d.targetY}) scale(1) rotate(0)`);
        
        // Add orbit animation for fun
        if (this.animateChanges) {
            nodeUpdate.filter(d => d.type !== 'root')
                .transition()
                .delay(1500)
                .duration(20000)
                .ease(d3.easeLinear)
                .attrTween('transform', function(d) {
                    const radius = Math.sqrt(Math.pow(d.targetX - centerX, 2) + Math.pow(d.targetY - centerY, 2));
                    const startAngle = Math.atan2(d.targetY - centerY, d.targetX - centerX);
                    return function(t) {
                        const angle = startAngle + (t * Math.PI * 2 * 0.1); // Slow rotation
                        const x = centerX + radius * Math.cos(angle);
                        const y = centerY + radius * Math.sin(angle);
                        return `translate(${x}, ${y}) scale(1)`;
                    };
                })
                .on('end', function repeat() {
                    d3.select(this)
                        .transition()
                        .duration(20000)
                        .ease(d3.easeLinear)
                        .attrTween('transform', function(d) {
                            const radius = Math.sqrt(Math.pow(d.targetX - centerX, 2) + Math.pow(d.targetY - centerY, 2));
                            const startAngle = Math.atan2(d.targetY - centerY, d.targetX - centerX);
                            return function(t) {
                                const angle = startAngle + (t * Math.PI * 2 * 0.1);
                                const x = centerX + radius * Math.cos(angle);
                                const y = centerY + radius * Math.sin(angle);
                                return `translate(${x}, ${y}) scale(1)`;
                            };
                        })
                        .on('end', repeat);
                });
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
        
        // Start with entry off-screen
        entry.style.transform = 'translateX(-100%)';
        entry.style.opacity = '0';
        
        log.insertBefore(entry, log.firstChild);
        
        // Animate entry sliding in
        if (this.animateChanges) {
            setTimeout(() => {
                entry.style.transition = 'all 0.3s ease-out';
                entry.style.transform = 'translateX(0)';
                entry.style.opacity = '1';
            }, 10);
        } else {
            entry.style.transform = 'translateX(0)';
            entry.style.opacity = '1';
        }
        
        // Keep only last 20 entries
        while (log.children.length > 20) {
            const lastChild = log.lastChild;
            if (this.animateChanges) {
                lastChild.style.transition = 'all 0.3s ease-out';
                lastChild.style.transform = 'translateX(100%)';
                lastChild.style.opacity = '0';
                setTimeout(() => log.removeChild(lastChild), 300);
            } else {
                log.removeChild(lastChild);
            }
        }
    }
}

// Initialize simulation when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.simulation = new DiscoverySimulation();
});