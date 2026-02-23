BINARY_NAME=repram

.PHONY: build run test clean docker-build docker-run docker-compose-up docker-compose-down

build:
	go build -o bin/$(BINARY_NAME) ./cmd/repram

run: build
	./bin/$(BINARY_NAME)

test:
	go test ./...

clean:
	go clean
	rm -rf bin/

docker-build:
	docker build -t repram/node:latest .

docker-run:
	docker run -p 8080:8080 -p 9090:9090 repram/node:latest

docker-compose-up:
	docker-compose up --build

docker-compose-down:
	docker-compose down
