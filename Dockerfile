# Multi-stage build for REPRAM node
FROM golang:1.22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the main node binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o repram-node ./cmd/node

# Build the cluster node binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o repram-cluster-node ./cmd/cluster-node

# Build the raw node binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o repram-node-raw ./cmd/node-raw

# Note: fade-cluster-node removed as cmd/fade-cluster-node doesn't exist

# Cluster node target
FROM alpine:latest AS cluster-node

# Install runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN adduser -D -s /bin/sh repram

# Set working directory
WORKDIR /app

# Copy cluster node binary only
COPY --from=builder /app/repram-cluster-node .

# Change ownership to non-root user
RUN chown -R repram:repram /app

# Switch to non-root user
USER repram

# Expose ports for HTTP API and gossip
EXPOSE 8080 9090

# Run cluster node
CMD ["./repram-cluster-node"]

# Raw node target
FROM alpine:latest AS raw-node

# Install runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN adduser -D -s /bin/sh repram

# Set working directory
WORKDIR /app

# Copy raw node binary only
COPY --from=builder /app/repram-node-raw .

# Change ownership to non-root user
RUN chown -R repram:repram /app

# Switch to non-root user
USER repram

# Expose default port
EXPOSE 8080

# Run raw node
CMD ["./repram-node-raw"]

# Default target - main node
FROM alpine:latest

# Install runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN adduser -D -s /bin/sh repram

# Set working directory
WORKDIR /app

# Copy main node binary
COPY --from=builder /app/repram-node .

# Change ownership to non-root user
RUN chown -R repram:repram /app

# Switch to non-root user
USER repram

# Expose default ports
EXPOSE 8080 8081

# Default command
CMD ["./repram-node"]