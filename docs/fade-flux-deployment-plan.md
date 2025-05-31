# Fade Flux Deployment Plan

## Overview
This document outlines the deployment strategy for the Fade demonstration application on Kubernetes using Flux GitOps.

## Architecture Decisions

### Container Strategy
We'll build and deploy **separate containers** for each component:

1. **cluster-node**: REPRAM cluster nodes with gossip protocol for replication
2. **fade-server**: The intelligent proxy and web UI server

**Rationale**: 
- Uses gossip-enabled cluster nodes for true message replication
- Fade server acts as load balancer and web UI proxy
- Messages sent to any node replicate automatically to all nodes
- Allows independent scaling of nodes vs. proxy
- Demonstrates true distributed storage capabilities

### Image Naming Convention
```
# Docker Hub public repository
ticktockbent/fade-server:v1.0.0
ticktockbent/repram-cluster-node:v1.0.0

# Alternative with custom domain (requires registry setup)
fade.repram.io/server:v1.0.0
fade.repram.io/cluster-node:v1.0.0
```

### Deployment Architecture

```
┌─────────────────┐
│   Ingress       │
│ (fade.demo.com) │
└────────┬────────┘
         │
┌────────▼────────┐
│  Fade Server    │ (1 replica, could scale for HA)
│  - Web UI       │
│  - Proxy Logic  │
│  - Load Balance │
└────────┬────────┘
         │
    ┌────┴────┬─────────┐
    │         │         │
┌───▼──┐  ┌──▼───┐  ┌──▼───┐
│Cluster│  │Cluster│  │Cluster│  (3+ replicas with gossip)
│Node-0 │  │Node-1 │  │Node-2 │
│:8080  │◄─┤:8080  │◄─┤:8080  │  ← Gossip replication
│:9090  │  │:9090  │  │:9090  │  ← Gossip ports
└──────┘  └──────┘  └──────┘
```

## GitOps Repository Structure

### Option 1: Single Repository (Recommended)
```
fade-gitops/
├── .github/
│   └── workflows/
│       └── docker-build.yaml    # Build and push images
├── clusters/
│   └── production/
│       ├── flux-system/         # Flux components
│       └── fade/
│           ├── namespace.yaml
│           ├── release.yaml     # HelmRelease
│           └── values.yaml      # Environment-specific values
├── infrastructure/
│   ├── sources/
│   │   └── helm-repos.yaml      # Helm repository definitions
│   └── configs/
│       └── network-policies.yaml
└── helm/
    └── fade/                    # Helm chart
        ├── Chart.yaml
        ├── values.yaml
        └── templates/
            ├── deployment-fade.yaml
            ├── statefulset-nodes.yaml
            ├── service-fade.yaml
            ├── service-nodes.yaml
            ├── configmap.yaml
            └── ingress.yaml
```

## Bootstrap Challenge Solution

The main complexity is node discovery in Kubernetes. Solutions:

### 1. StatefulSet with Predictable Names (Recommended)
```yaml
# Nodes will have predictable DNS names:
# repram-node-0.repram-nodes.fade.svc.cluster.local
# repram-node-1.repram-nodes.fade.svc.cluster.local
# repram-node-2.repram-nodes.fade.svc.cluster.local

# Fade server config:
REPRAM_NODES: "repram-node-0.repram-nodes:8080,repram-node-1.repram-nodes:8080,repram-node-2.repram-nodes:8080"
```

### 2. Headless Service Discovery
```yaml
# Create a headless service that returns all pod IPs
# Fade server can query DNS for all available nodes
```

## Build Pipeline (GitHub Actions)

```yaml
name: Build and Deploy
on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
      
      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_TOKEN }}
      
      - name: Build and push fade-server
        uses: docker/build-push-action@v4
        with:
          context: .
          file: ./Dockerfile.fade
          push: true
          tags: |
            ticktockbent/fade-server:latest
            ticktockbent/fade-server:${{ github.sha }}
      
      - name: Build and push repram-node
        uses: docker/build-push-action@v4
        with:
          context: .
          file: ./Dockerfile
          target: node-raw  # Multi-stage build target
          push: true
          tags: |
            ticktockbent/repram-node:latest
            ticktockbent/repram-node:${{ github.sha }}
```

## Flux Configuration

### HelmRelease
```yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: fade
  namespace: fade
spec:
  interval: 5m
  chart:
    spec:
      chart: ./helm/fade
      sourceRef:
        kind: GitRepository
        name: fade-gitops
        namespace: flux-system
  values:
    fade:
      image:
        repository: ticktockbent/fade-server
        tag: latest # Will be updated by CI
      replicaCount: 1
      service:
        type: ClusterIP
        port: 3000
    
    nodes:
      image:
        repository: ticktockbent/repram-node
        tag: latest # Will be updated by CI
      replicaCount: 3
      persistence:
        enabled: false # Ephemeral storage
      resources:
        requests:
          memory: "128Mi"
          cpu: "100m"
        limits:
          memory: "256Mi"
          cpu: "200m"
```

## Deployment Steps

1. **Create Docker Hub repositories**
   - ticktockbent/fade-server
   - ticktockbent/repram-node

2. **Set up GitHub repository secrets**
   - DOCKER_USERNAME
   - DOCKER_TOKEN

3. **Create Flux GitOps repository**
   - Initialize with structure above
   - Add Helm chart for fade

4. **Bootstrap Flux on cluster**
   ```bash
   flux bootstrap github \
     --owner=ticktockbent \
     --repository=fade-gitops \
     --branch=main \
     --path=./clusters/production
   ```

5. **Configure image automation** (optional)
   - Use Flux image automation controllers
   - Auto-update image tags on new builds

## Challenges and Solutions

### 1. Node Bootstrap
**Challenge**: Nodes need to know about each other without a discovery service.
**Solution**: Use StatefulSet with predictable DNS names and configure fade server with all node endpoints.

### 2. Load Distribution
**Challenge**: Ensure even distribution of traffic across nodes.
**Solution**: Fade server already implements round-robin with failover.

### 3. Health Checks
**Challenge**: Kubernetes needs to know when nodes/fade server are healthy.
**Solution**: Configure proper liveness/readiness probes using `/health` endpoints.

### 4. Ephemeral Storage
**Challenge**: Pods restart and lose data (which is intended behavior).
**Solution**: Document this as expected behavior for the demo.

## Next Steps

1. Decide on Docker Hub vs. custom registry
2. Create GitHub repository for GitOps
3. Write Helm chart for fade deployment
4. Set up GitHub Actions workflow
5. Bootstrap Flux on target cluster
6. Test deployment and iterate

## Alternative: Bundled Deployment

If you prefer a simpler approach, we could bundle fade-server + node in a single container, but this would:
- Lose the distributed demonstration aspect
- Make the architecture less clear
- Reduce flexibility

The separate deployment better demonstrates REPRAM's distributed nature and fade's intelligent proxy capabilities.