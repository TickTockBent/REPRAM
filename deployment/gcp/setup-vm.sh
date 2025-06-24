#!/bin/bash

# GCP VM Setup Script for REPRAM Cluster
# This script sets up a free-tier e2-micro VM to run 3 REPRAM nodes

set -e

echo "🚀 Setting up REPRAM cluster on GCP VM..."

# Update system
echo "📦 Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# Install Docker
echo "🐳 Installing Docker..."
sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io

# Install Docker Compose
echo "🔧 Installing Docker Compose..."
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Add current user to docker group
sudo usermod -aG docker $USER

# Install additional tools
echo "🛠️ Installing additional tools..."
sudo apt-get install -y git curl htop nano

# Check if we're already in a REPRAM repository
if [ -f "go.mod" ] && grep -q "repram" go.mod; then
    echo "📁 Already in REPRAM repository directory"
    REPRAM_DIR=$(pwd)
else
    # Create project directory and clone
    echo "📁 Creating project directory..."
    mkdir -p /home/$USER/repram
    cd /home/$USER/repram
    
    # Clone REPRAM repository (replace with your repo URL)
    echo "📥 Cloning REPRAM repository..."
    git clone https://github.com/your-username/REPRAM.git .
    REPRAM_DIR=/home/$USER/repram
fi

# Set up firewall rules
echo "🔥 Configuring firewall..."
sudo ufw allow ssh
sudo ufw allow 8081:8083/tcp
sudo ufw allow 9091:9093/tcp
sudo ufw --force enable

# Build Docker images
echo "🏗️ Building Docker images..."
sudo docker build -t repram:latest .

# Create systemd service for auto-start
echo "⚙️ Creating systemd service..."
sudo tee /etc/systemd/system/repram-cluster.service > /dev/null <<EOF
[Unit]
Description=REPRAM Cluster
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/$USER/repram/deployment/gcp
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=0
User=$USER
Group=docker

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable repram-cluster.service

# Start the cluster
echo "🎯 Starting REPRAM cluster..."
cd /home/$USER/repram/deployment/gcp
sudo docker-compose up -d

# Wait for nodes to be ready
echo "⏳ Waiting for nodes to be ready..."
sleep 30

# Check node health
echo "🩺 Checking node health..."
for port in 8081 8082 8083; do
    if curl -f http://localhost:$port/health > /dev/null 2>&1; then
        echo "✅ Node on port $port is healthy"
    else
        echo "❌ Node on port $port is not responding"
    fi
done

# Display status
echo "📊 Cluster status:"
sudo docker-compose ps

echo ""
echo "🎉 REPRAM cluster setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Note your external IP: $(curl -s ifconfig.me)"
echo "2. Update FADE config.js with this IP"
echo "3. Verify nodes are accessible from outside:"
echo "   curl http://$(curl -s ifconfig.me):8081/health"
echo ""
echo "🔗 Node endpoints:"
echo "   Node 1: http://$(curl -s ifconfig.me):8081"
echo "   Node 2: http://$(curl -s ifconfig.me):8082"
echo "   Node 3: http://$(curl -s ifconfig.me):8083"
echo ""
echo "🐳 Docker commands:"
echo "   View logs: sudo docker-compose logs -f"
echo "   Restart:   sudo docker-compose restart"
echo "   Stop:      sudo docker-compose down"
echo "   Start:     sudo docker-compose up -d"