# Discord-REPRAM Bridge Dockerfile
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY *.go ./
COPY config.yaml ./

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o discord-bridge .

# Final stage
FROM alpine:latest

# Install ca-certificates for HTTPS requests
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy the binary and config
COPY --from=builder /app/discord-bridge .
COPY --from=builder /app/config.yaml .

# Create logs directory
RUN mkdir -p logs

# Expose port (if needed for health checks)
EXPOSE 8080

# Run the bridge
CMD ["./discord-bridge"]