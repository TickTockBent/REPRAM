FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o repram ./cmd/repram

FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata
RUN adduser -D -s /bin/sh repram
WORKDIR /app
COPY --from=builder /app/repram .
RUN chown -R repram:repram /app
USER repram
EXPOSE 8080 9090
CMD ["./repram"]
