BINARY_NAME=repram-node
RAW_BINARY=repram-node-raw
CLUSTER_BINARY=repram-cluster-node
EXAMPLE_BINARY=repram-example
SDK_EXAMPLE=repram-sdk-example

.PHONY: build build-raw build-cluster build-example build-sdk-example run run-raw run-cluster test clean example sdk-example

build:
	go build -o bin/$(BINARY_NAME) cmd/node/main.go

build-raw:
	go build -o bin/$(RAW_BINARY) cmd/node-raw/main.go

build-cluster:
	go build -o bin/$(CLUSTER_BINARY) cmd/cluster-node/main.go

build-example:
	go build -o bin/$(EXAMPLE_BINARY) cmd/example/main.go

build-sdk-example:
	cd repram-sdk && go mod tidy && go build -o ../bin/$(SDK_EXAMPLE) example/main.go

run: build
	./bin/$(BINARY_NAME)

run-raw: build-raw
	./bin/$(RAW_BINARY)

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