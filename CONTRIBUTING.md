# Contributing to REPRAM

Thank you for your interest in contributing to REPRAM! We welcome contributions from the community and are grateful for any help you can provide.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and collaborative environment. We expect all contributors to:
- Be respectful and inclusive
- Accept constructive criticism gracefully
- Focus on what's best for the project and community
- Show empathy towards other contributors

## How to Contribute

### 1. Getting Started

1. **Fork the repository** to your GitHub account
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/REPRAM.git
   cd REPRAM
   ```
3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/REPRAM.git
   ```
4. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

### 2. Before You Code

- **Read the documentation**:
  - [Core Principles](docs/core-principles.md) - MUST READ before contributing
  - [Project Overview](docs/project-overview.md)

- **Check existing issues** to see if someone's already working on it
- **Open an issue** to discuss significant changes before implementing

### 3. Development Guidelines

#### Code Standards
- Write clean, maintainable Go code
- Follow [Effective Go](https://golang.org/doc/effective_go.html) guidelines
- Use `gofmt` for code formatting
- Add comments for exported functions and types
- Keep functions focused and small

#### Testing Requirements
- Write tests for new functionality
- Ensure all tests pass: `make test`
- Include both unit and integration tests where appropriate

#### Commit Guidelines
- Use clear, descriptive commit messages
- Follow conventional commits format:
  ```
  feat: add new gossip protocol implementation
  fix: resolve memory leak in storage cleanup
  docs: update API documentation
  test: add tests for TTL enforcement
  refactor: simplify node initialization
  ```
- Keep commits atomic and focused

### 4. Submitting a Pull Request

1. **Update your fork**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run all checks locally**:
   ```bash
   make build
   make test
   ```

3. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

4. **Create Pull Request**:
   - Use a clear, descriptive title
   - Reference any related issues
   - Describe what changed and why
   - Include testing instructions

## Development Setup

### Prerequisites
- Go 1.21 or higher
- Make
- Git
- Docker (optional, for containerized testing)

### Quick Start
```bash
# Clone and setup
git clone https://github.com/YOUR_USERNAME/REPRAM.git
cd REPRAM

# Build
make build

# Run tests
make test

# Start a node
make run
```

## Architecture Principles

When contributing, please maintain:
1. **Zero-knowledge nodes** - Nodes never interpret data
2. **Client-side encryption** - Encryption is always the client's concern
3. **Ephemeral by design** - Everything has a TTL, expired data is permanently gone
4. **Permissionless reads** - No auth at node level
5. **Single binary** - One `cmd/repram` entry point, cluster-capable by default

## Questions?

- Open a [GitHub Issue](https://github.com/ORIGINAL_OWNER/REPRAM/issues)
- Check existing [Discussions](https://github.com/ORIGINAL_OWNER/REPRAM/discussions)

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (see LICENSE file).
