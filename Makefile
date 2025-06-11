BINARY_NAME=repram-node
CLUSTER_BINARY=repram-cluster-node
EXAMPLE_BINARY=repram-example
SDK_EXAMPLE=repram-sdk-example

.PHONY: build build-raw build-cluster build-example build-sdk-example run run-raw run-cluster test clean example sdk-example docker-build docker-run docker-compose-up docker-compose-down docker-compose-cluster load-test-build load-test load-test-ramp load-test-stress docker-scale-test-quick docker-scale-test-full docker-scale-test-stress docker-monitor docker-monitor-long demo-server

build:
	go build -o bin/$(BINARY_NAME) cmd/node/main.go


build-cluster:
	go build -o bin/$(CLUSTER_BINARY) cmd/cluster-node/main.go

build-example:
	go build -o bin/$(EXAMPLE_BINARY) cmd/example/main.go

build-sdk-example:
	cd repram-sdk && go mod tidy && go build -o ../bin/$(SDK_EXAMPLE) example/main.go

run: build
	./bin/$(BINARY_NAME)

run-cluster: build-cluster
	./bin/$(CLUSTER_BINARY)

example: build-example
	./bin/$(EXAMPLE_BINARY)

sdk-example: build-sdk-example
	./bin/$(SDK_EXAMPLE)

test:
	go test ./...

clean:
	go clean
	rm -rf bin/
	cd repram-sdk && go clean

demo-opensource: build-raw
	@echo "=== REPRAM Open Source Node Demo ==="
	@echo "Starting node (stores unencrypted data)..."
	./bin/$(RAW_BINARY) &
	@sleep 2
	@echo "Storing unencrypted data..."
	@curl -X POST http://localhost:8080/raw/put -H "Content-Type: application/json" -d '{"data":"Hello Open Source REPRAM!","ttl":60}' | jq
	@echo "Retrieving data..."
	@curl http://localhost:8080/raw/get/raw-* 2>/dev/null | jq || echo "Data may have expired"
	@pkill repram-node-raw

demo-sdk: build-sdk-example
	@echo "=== REPRAM Proprietary SDK Demo ==="
	@echo "Starting node..."
	./bin/$(BINARY_NAME) &
	@sleep 2
	@echo "Running SDK example (encrypted data)..."
	make sdk-example
	@pkill repram-node

# Docker commands
docker-build:
	docker build -t repram:latest .

docker-run:
	docker run -p 8080:8080 repram:latest

docker-compose-up:
	docker-compose up --build

docker-compose-down:
	docker-compose down

docker-compose-cluster:
	docker-compose up --build repram-cluster-1 repram-cluster-2 repram-cluster-3

# Load testing
load-test-build:
	cd test/load && go build -o load-tester .

load-test: load-test-build
	./scripts/load-test.sh

load-test-ramp: load-test-build
	./scripts/load-test.sh --type ramp

load-test-stress: load-test-build
	./scripts/load-test.sh --type stress

# Docker scale testing
docker-scale-test-quick:
	./scripts/docker-scale-test.sh --quick

docker-scale-test-full:
	./scripts/docker-scale-test.sh --full

docker-scale-test-stress:
	./scripts/docker-scale-test.sh --stress

docker-monitor:
	./scripts/docker-monitoring.sh

docker-monitor-long:
	./scripts/docker-monitoring.sh --duration 1800

# Discovery Protocol Demo Server
demo-server:
	@echo "Starting Discovery Protocol Demo server at http://localhost:3001"
	@echo "Open http://localhost:3001/ in your browser"
	@echo "Press Ctrl+C to stop"
	@cd demos/discovery-protocol && python3 -m http.server 3001