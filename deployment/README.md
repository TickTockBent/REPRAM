# REPRAM Strategic Deployment Guide

This document outlines the new strategic deployment approach, moving from complex Flux deployment to a reliable traditional infrastructure setup.

## 🎯 **Architecture Overview**

```
┌─────────────────┐     HTTPS      ┌─────────────────┐
│     Vercel      │ ◄──────────────► │   GCP VM        │
│  (FADE Demo)    │                 │ (3 REPRAM Nodes)│
└─────────────────┘                 └─────────────────┘
         ▲                                    ▲
         │                                    │
    HTTPS│                           HTTP API│
         │                                    │
         ▼                                    ▼
┌─────────────────┐                 ┌─────────────────┐
│    End Users    │                 │  Discord Bot    │
│   (Browsers)    │                 │  (Bridge)       │
└─────────────────┘                 └─────────────────┘
```

## 📋 **Deployment Components**

### 1. **Vercel Frontend** (`web/fade/`)
- **Technology**: Static HTML/CSS/JS hosting
- **Purpose**: FADE demo frontend
- **Benefits**: 
  - Global CDN distribution
  - Automatic HTTPS
  - Zero configuration
  - Free tier suitable for demo

### 2. **GCP Free-Tier Backend** (`deployment/gcp/`)
- **Technology**: e2-micro VM (2 vCPU, 1GB RAM)
- **Purpose**: 3-node REPRAM cluster
- **Benefits**:
  - Always-free tier
  - Hardcoded peer discovery (no complex service discovery)
  - Docker containerization
  - Systemd auto-restart

### 3. **Discord Bridge** (`deployment/discord-bridge/`)
- **Technology**: Go service with DiscordGo
- **Purpose**: Ephemeral message bridging
- **Benefits**:
  - TTL-based auto-deletion
  - Bi-directional synchronization
  - Custom TTL commands
  - Key embedding for tracking

## 🚀 **Quick Start Guide**

### Phase 1: Deploy FADE to Vercel

1. **Fork/Clone Repository**
```bash
git clone https://github.com/your-username/REPRAM.git
cd REPRAM
```

2. **Deploy to Vercel**
```bash
cd web/fade
vercel deploy
```

3. **Update Configuration**
- Note your Vercel domain
- Configuration is already set for `vercel.app` domains

### Phase 2: Set Up GCP Cluster

1. **Create GCP VM**
```bash
# Create e2-micro instance in us-central1
gcloud compute instances create repram-cluster \
  --machine-type=e2-micro \
  --zone=us-central1-a \
  --image-family=ubuntu-2004-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --tags=repram-cluster
```

2. **Configure Firewall**
```bash
gcloud compute firewall-rules create repram-http \
  --allow=tcp:8081-8083 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=repram-cluster
```

3. **Deploy Cluster**
```bash
# SSH to VM
gcloud compute ssh repram-cluster --zone=us-central1-a

# Run setup script
curl -sSL https://raw.githubusercontent.com/your-username/REPRAM/main/deployment/gcp/setup-vm.sh | bash
```

4. **Update FADE Configuration**
```bash
# Get VM external IP
EXTERNAL_IP=$(gcloud compute instances describe repram-cluster --zone=us-central1-a --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

# Update FADE config (replace YOUR_GCP_EXTERNAL_IP)
sed -i "s/YOUR_GCP_EXTERNAL_IP/$EXTERNAL_IP/g" web/fade/config.js
```

### Phase 3: Deploy Discord Bridge

1. **Create Discord Bot**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Create application and bot
   - Copy bot token
   - Invite to server with message permissions

2. **Configure Bridge**
```bash
cd deployment/discord-bridge
cp config.yaml.example config.yaml
# Edit config.yaml with your Discord token and channel ID
```

3. **Deploy to GCP VM**
```bash
# Copy to VM
scp -r discord-bridge/ username@$EXTERNAL_IP:/home/username/

# SSH and run
ssh username@$EXTERNAL_IP
cd discord-bridge
go mod tidy
go build -o discord-bridge
./discord-bridge
```

## 📁 **Directory Structure**

```
deployment/
├── gcp/
│   ├── docker-compose.yml       # 3-node cluster configuration
│   ├── setup-vm.sh             # Automated VM setup script
│   └── cluster-config.env      # Hardcoded bootstrap config
├── discord-bridge/
│   ├── main.go                 # Main bridge application
│   ├── config.go               # Configuration handling
│   ├── repram-client.go        # REPRAM API client
│   ├── message-tracker.go      # TTL tracking system
│   ├── config.yaml             # Bridge configuration
│   ├── go.mod                  # Go module definition
│   └── README.md               # Bridge documentation
└── README.md                   # This deployment guide
```

## 🔧 **Configuration Management**

### Environment Variables
```bash
# GCP VM
export EXTERNAL_IP="your-gcp-ip"
export DISCORD_TOKEN="your-bot-token"
export DISCORD_CHANNEL_ID="your-channel-id"

# Update configurations
envsubst < config.template.yaml > config.yaml
```

### Dynamic Updates
```bash
# Update FADE configuration
./scripts/update-config.sh $EXTERNAL_IP

# Restart services
sudo systemctl restart repram-cluster
sudo systemctl restart discord-bridge
```

## 📊 **Monitoring & Health Checks**

### REPRAM Cluster Health
```bash
# Check all nodes
for port in 8081 8082 8083; do
  curl http://$EXTERNAL_IP:$port/health
done

# View cluster status
curl http://$EXTERNAL_IP:8081/status
```

### Docker Container Status
```bash
# SSH to VM
sudo docker-compose -f /home/username/repram/deployment/gcp/docker-compose.yml ps

# View logs
sudo docker-compose logs -f repram-node-1
```

### Discord Bridge Status
```bash
# Check process
ps aux | grep discord-bridge

# View logs
tail -f /home/username/discord-bridge/bridge.log
```

## 🐛 **Troubleshooting**

### Common Issues

1. **CORS Errors**
   - Verify Vercel deployment includes `vercel.json`
   - Check GCP firewall rules allow HTTP traffic

2. **Node Communication Issues**
   - Verify Docker network connectivity
   - Check gossip ports (9091-9093) are accessible internally

3. **Discord Bot Not Responding**
   - Verify bot token and permissions
   - Check Discord API rate limits

### Log Locations
```bash
# Docker logs
sudo docker-compose logs

# System logs
journalctl -u repram-cluster
journalctl -u discord-bridge

# Application logs
tail -f /var/log/repram-cluster.log
tail -f /home/username/discord-bridge/bridge.log
```

## 💰 **Cost Analysis**

### Free Tier Usage
- **Vercel**: 100GB bandwidth/month (free)
- **GCP e2-micro**: Always free in us-central1
- **Discord**: Free API usage

### Estimated Monthly Costs
- **Total**: $0.00 (within free tier limits)
- **Scaling**: Additional VMs ~$7/month each

## 🔐 **Security Considerations**

### Network Security
- Minimal firewall exposure (only HTTP ports)
- No SSH keys in containers
- Regular security updates via setup script

### Application Security
- Discord bot token protection
- No sensitive data in REPRAM storage
- HTTPS for all frontend traffic

### Data Privacy
- Ephemeral storage (TTL-based deletion)
- No persistent user data
- Message tracking for cleanup only

## 📈 **Performance Expectations**

### FADE Demo
- **Response Time**: <100ms (Vercel CDN)
- **Throughput**: ~1000 concurrent users
- **Availability**: 99.9% (Vercel SLA)

### REPRAM Cluster
- **Storage**: ~500MB available (free tier)
- **Throughput**: ~100 req/sec per node
- **Message Capacity**: ~10,000 concurrent messages

### Discord Bridge
- **Sync Delay**: ~10 seconds (configurable)
- **Message Rate**: Limited by Discord API (2000/10min)
- **TTL Accuracy**: ±60 seconds

## 🎉 **Success Metrics**

- ✅ FADE demo accessible via Vercel
- ✅ 3-node REPRAM cluster running on GCP
- ✅ Discord bridge syncing messages bi-directionally
- ✅ TTL-based message expiration working
- ✅ Zero ongoing infrastructure costs
- ✅ Simple deployment and maintenance

This strategic shift provides a reliable, cost-effective foundation for demonstrating REPRAM's capabilities while maintaining the ephemeral messaging vision.