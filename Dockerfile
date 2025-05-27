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

# Final stage - minimal runtime image
FROM alpine:latest

# Install runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user
RUN adduser -D -s /bin/sh repram

# Set working directory
WORKDIR /app

# Copy binaries from builder
COPY --from=builder /app/repram-node .
COPY --from=builder /app/repram-cluster-node .
COPY --from=builder /app/repram-node-raw .

# Change ownership to non-root user
RUN chown -R repram:repram /app

# Switch to non-root user
USER repram

# Expose default ports
EXPOSE 8080 8081

# Default command (can be overridden)
CMD ["./repram-node"]