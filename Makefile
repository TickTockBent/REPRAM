BINARY_NAME=repram
OMEGA_BINARY_NAME=repram-omega
DASHBOARD_BINARY_NAME=repram-dashboard

# Burn-in cluster seeds — useful for `make dashboard-run-burnin` smoke tests.
BURNIN_SEEDS=10.0.20.72:18080,10.0.10.81:18080,10.0.10.104:18080

.PHONY: build build-omega build-dashboard run dashboard-run-burnin test clean docker-build docker-run docker-compose-up docker-compose-down

build:
	go build -o bin/$(BINARY_NAME) ./cmd/repram
	go build -o bin/$(OMEGA_BINARY_NAME) ./cmd/repram-omega
	go build -o bin/$(DASHBOARD_BINARY_NAME) ./cmd/dashboard

build-omega:
	go build -o bin/$(OMEGA_BINARY_NAME) ./cmd/repram-omega

build-dashboard:
	go build -o bin/$(DASHBOARD_BINARY_NAME) ./cmd/dashboard

dashboard-run-burnin: build-dashboard
	./bin/$(DASHBOARD_BINARY_NAME) \
		--seeds=$(BURNIN_SEEDS) \
		--state-dir=$(CURDIR)/.dashboard-state \
		--listen=127.0.0.1:18181 \
		--internal-addr=127.0.0.1:18182 \
		--poll-interval=30s

run: build
	./bin/$(BINARY_NAME)

test:
	go test ./...

clean:
	go clean
	rm -rf bin/

docker-build:
	docker build -t ticktockbent/repram-node:latest .

docker-run:
	docker run -p 8080:8080 -p 9090:9090 ticktockbent/repram-node:latest

docker-compose-up:
	docker-compose up --build

docker-compose-down:
	docker-compose down
