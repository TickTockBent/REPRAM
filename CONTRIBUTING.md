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
  - [Development Plan](docs/development-plan.md)
  - [CLAUDE.md](CLAUDE.md) - Project-specific guidance

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
- Aim for >80% code coverage on new code
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
   make test
   make build
   make build-raw
   make build-cluster
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
   - Add screenshots for UI changes

5. **PR Template**:
   ```markdown
   ## Description
   Brief description of changes

   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update

   ## Testing
   - [ ] All tests pass
   - [ ] Added new tests
   - [ ] Manual testing completed

   ## Checklist
   - [ ] Follows core principles
   - [ ] Code follows project style
   - [ ] Self-review completed
   - [ ] Documentation updated
   ```

### 5. Review Process

- All PRs require at least one review before merging
- Address reviewer feedback promptly
- Be patient - reviews may take a few days
- Don't take feedback personally - it's about the code, not you

## Areas for Contribution

### High Priority
- **Gossip Protocol**: Improve cluster node replication
- **Performance**: Optimize memory usage and TTL cleanup
- **Testing**: Increase test coverage, add benchmarks
- **Documentation**: Improve API docs, add examples

### Feature Ideas
- **Storage Backends**: Add persistent storage options (while maintaining TTL)
- **Monitoring**: Prometheus metrics, health dashboards
- **SDK Languages**: Python, JavaScript, Ruby clients
- **Security**: Additional encryption options, audit logging

### Good First Issues
Look for issues labeled:
- `good-first-issue` - Great for newcomers
- `help-wanted` - We need assistance
- `documentation` - Doc improvements
- `testing` - Test additions

## Development Setup

### Prerequisites
- Go 1.22 or higher
- Make
- Git
- Docker (optional, for containerized testing)

### Quick Start
```bash
# Clone and setup
git clone https://github.com/YOUR_USERNAME/REPRAM.git
cd REPRAM

# Build everything
make build
make build-raw
make build-cluster

# Run tests
make test

# Start a node
make run-raw
```

## Architecture Decisions

When contributing, please maintain:
1. **Zero-knowledge nodes** - Nodes never interpret data
2. **Client-side encryption** - All crypto happens in SDK
3. **Ephemeral by design** - Everything has a TTL
4. **Public readability** - No auth at node level
5. **Pure key-value** - No complex queries or indexes

## Questions?

- Open a [GitHub Issue](https://github.com/ORIGINAL_OWNER/REPRAM/issues)
- Check existing [Discussions](https://github.com/ORIGINAL_OWNER/REPRAM/discussions)
- Review the [FAQ](docs/FAQ.md) (if available)

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (see LICENSE file).

## Recognition

Contributors will be recognized in:
- GitHub's contributor graph
- CONTRIBUTORS.md file (for significant contributions)
- Release notes mentioning contributor handles

Thank you for helping make REPRAM better! 🚀