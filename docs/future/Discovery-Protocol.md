# REPRAM Tree Discovery Protocol Summary

## Overview

REPRAM uses a self-organizing tree structure for peer discovery combined with completely random gossip for message propagation. The tree serves only as an address book - it tells nodes who exists in the network, but does not constrain communication patterns.

## Node Hierarchy and Roles

### Root Nodes (3-10 globally)
Root nodes are statically configured bootstrap entry points with known IP addresses. They coordinate the global network topology and serve as the foundation for tree growth. Root nodes communicate with all other root nodes and maintain the authoritative view of network structure.

### Trunk Nodes  
Trunk nodes connect directly to root nodes and serve as regional distribution points. They typically represent continental or major geographic regions. Trunk nodes relay topology information between their local branches and the global root network.

### Branch Nodes
Branch nodes attach to trunk nodes and create local area clusters. They serve as connection points for leaf nodes within their geographic or network proximity region. Branch nodes help distribute load and create natural organizational boundaries.

### Leaf Nodes
Leaf nodes are the majority of network participants. They attach to available branch nodes and represent the edge of the tree structure. Most REPRAM users and applications connect as leaf nodes.

## Bootstrap and Discovery Process

### Initial Connection
When a node starts up, it first determines if it is a configured root node by checking if its IP address matches any of the hardcoded root addresses. If it is a root node, it coordinates with other roots to establish its position in the root network.

### Non-Root Attachment
Non-root nodes begin by testing latency to all known root nodes and selecting the one with the best performance. They request the current network topology from this root, which includes information about all trunks, branches, and their current capacity.

### Tree Attachment Strategy
Nodes attempt to attach at the deepest possible level in the tree:

    Become a Leaf: If branch nodes exist with available capacity, attach to the branch with the best latency
    Become a Branch: If no branches are available but trunks exist with capacity, attach to the best trunk as a new branch
    Become a Trunk: If no trunks have capacity, attach directly to the root as a new trunk

### Capacity Management
Each node type has configurable capacity limits:
- Trunk nodes typically support 5-15 branch connections
- Branch nodes typically support 10-25 leaf connections  
- When capacity is exceeded, new nodes are promoted to create parallel structures

## Geographic Self-Organization

### Latency-Based Clustering
The tree naturally organizes itself based on network latency measurements. Nodes automatically cluster with others that are geographically or network-topologically close, creating efficient regional groupings without explicit geographic configuration.

### Global Distribution
With geographically distributed root nodes, separate trees grow from each root across different continents. This creates natural regional boundaries while maintaining global connectivity through root coordination.

## Dynamic Rebalancing and Optimization

### Periodic Evaluation
Nodes periodically reassess their position in the tree, typically every 10-30 minutes. They evaluate whether a significantly better attachment point has become available and consider migration if the improvement is substantial and persistent.

### Migration Hysteresis
To prevent network instability, nodes only migrate when improvements exceed 25% and persist for at least 5 minutes. A cooldown period of 10 minutes between migrations prevents flapping behavior.

### Performance-Based Optimization
Nodes continuously monitor their connection quality and can proactively seek better positions when performance degrades. This creates a self-optimizing network that adapts to changing conditions.

## Failure Recovery and Self-Healing

### Parent Failure Handling
When a parent node fails, orphaned nodes follow a structured recovery process:
- Leaf nodes attempt to attach to sibling branches, or promote to become a new branch
- Branch nodes attempt to attach to sibling trunks, or promote to become a new trunk  
- Trunk nodes coordinate with remaining roots or participate in root selection

### Gradual Degradation Response
Before complete failure, nodes experiencing performance degradation are handled gracefully:
- Reduced traffic load while monitoring for improvement
- Establishment of backup connections
- Gradual migration if degradation persists

### Network Partition Recovery
When network partitions are detected (fewer than 50% of expected peers responding), nodes automatically re-bootstrap from the configured root addresses to rejoin the main network.

## Separation from Gossip Protocol

### Pure Discovery Function
The tree structure exists solely for peer discovery and network organization. It provides each node with a comprehensive list of all other network participants but does not constrain communication patterns.

### Random Gossip Independence  
Once nodes have discovered their peers through the tree structure, message propagation uses completely random selection. Each message is forwarded to randomly chosen peers regardless of tree position, ensuring efficient coverage without hierarchical bottlenecks.

### Peer List Maintenance
The tree discovery process continuously maintains an up-to-date list of all network participants. This peer list serves as the foundation for random gossip selection, ensuring that messages can reach any node in the network.

## Peer Diversity and Network Health

### Random Peer Sampling
Beyond the tree structure, nodes maintain diversity through periodic random peer sampling. They regularly exchange peer information with other nodes to discover connections outside their immediate tree segment.

### Gossip Diversity
When propagating messages, nodes use a hybrid approach: 70% of gossip targets come from tree-discovered peers (for reliability) while 30% come from randomly sampled peers (for diversity and edge case coverage).

### Cross-Tree Connections
Nodes establish occasional connections across different tree branches and even different root trees to ensure network-wide connectivity and prevent isolation of tree segments.

## Scalability and Performance

### Logarithmic Scaling
The tree structure maintains O(log N) depth regardless of network size, ensuring that peer discovery remains efficient even as the network grows to thousands of nodes.

### Geographic Efficiency
Natural geographic clustering means that most communication stays within regional boundaries, reducing latency and bandwidth costs while maintaining global connectivity.

### Load Distribution
The hierarchical structure naturally distributes topology management load, preventing any single node from becoming overwhelmed with coordination responsibilities.

## Configuration and Tuning

### Adaptive Parameters
Key parameters like capacity limits, rebalancing intervals, and migration thresholds can be tuned based on network conditions and performance requirements.

### Bootstrap Configuration
The system requires only a simple configuration file listing the IP addresses of root nodes. All other organization emerges automatically from the discovery protocol.

### Monitoring and Observability
Nodes export metrics about their tree position, connection quality, and organizational health, enabling network operators to monitor the self-organization process.

## Benefits and Trade-offs

### Advantages
- Self-Organization: No manual network configuration required
- Scalability: Handles thousands of nodes efficiently  
- Resilience: Multiple failure recovery mechanisms
- Performance: Natural latency optimization through geographic clustering
- Simplicity: Uniform node software with emergent role differentiation

### Considerations  
- Bootstrap Dependency: Initial connection requires accessible root nodes
- Convergence Time: Network organization may take several minutes after major changes
- Migration Overhead: Tree rebalancing creates temporary network churn

## Future Enhancements

The tree discovery protocol provides a solid foundation for additional features like consensus layer integration, advanced geographic optimization, and machine learning-based predictive failure detection. The separation between discovery and gossip ensures that these enhancements can be added without disrupting the core communication patterns.