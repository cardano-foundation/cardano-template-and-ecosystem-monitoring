# Test Scripts

This directory contains scripts for testing all Cardano examples locally. These scripts use the **same commands** as the GitHub Actions workflow, ensuring identical behavior between local and CI testing.

## Design Philosophy

**Shared Logic, Different Orchestration:**

- **Local scripts** (these files): Run tests **sequentially** for easy debugging
- **GitHub Actions** (`.github/workflows/ecosystem-test.yml`): Run tests **in parallel** for speed
- **Both use identical commands**: `aiken check`, `aiken build`, `jbang`, etc.

The discovery script (`local-test-discovery.sh`) is **directly reused** by GitHub Actions.

## Quick Start

### Run Full Test Suite
```bash
./scripts/local-test-all.sh
```

This will:
1. Discover all examples
2. Compile all Aiken contracts
3. Start Yaci DevKit (if not running)
4. Run all off-chain tests
5. Generate a comprehensive report

### Run Individual Steps

#### 1. Discovery Only
```bash
./scripts/local-test-discovery.sh
```
Scans the repository and lists all examples by technology stack.

#### 2. Compile Aiken Only
```bash
./scripts/local-test-aiken.sh
```
Compiles all Aiken smart contracts and verifies `plutus.json` generation.

#### 3. Run Off-chain Tests Only
```bash
# Start Yaci DevKit first
yaci-devkit up --enable-yaci-store

# Then run tests
./scripts/local-test-offchain.sh
```
Runs all CCL Java, Mesh.js, and Lucid Evolution tests against Yaci DevKit.

#### 4. Generate Report Only
```bash
./scripts/local-test-report.sh
```
Generates a markdown report from existing test results in `.local-test-results/`.

## Prerequisites

### Required Tools

1. **Aiken** - v1.1.17+ (for on-chain compilation)
   ```bash
   curl --proto '=https' --tlsv1.2 -LsSf https://install.aiken-lang.org | sh
   source $HOME/.aiken/bin/env
   aikup  # Installs latest stable version
   aiken --version
   ```

2. **Java** - JDK 24+ (for CCL Java tests)
   ```bash
   # macOS
   brew install openjdk@24

   # Linux - Download from https://adoptium.net/
   java --version
   ```

3. **JBang** - Latest (for running CCL Java scripts)
   ```bash
   # macOS
   brew install jbang

   # Linux
   curl -Ls https://sh.jbang.dev | bash -s - app setup

   jbang version
   ```

4. **Deno** - v2.0+ (for Mesh.js/Lucid tests)
   ```bash
   # macOS
   brew install deno

   # Linux
   curl -fsSL https://deno.land/install.sh | sh

   deno --version  # Must be 2.0+
   ```

5. **Yaci DevKit** - Latest (for local testnet)
   ```bash
   npm install -g @bloxbean/yaci-devkit
   yaci-devkit --version
   ```

### Optional: Install Only What You Need

- To test **only Aiken**: Install Aiken
- To test **only CCL Java**: Install Aiken + JBang + Yaci DevKit
- To test **only Mesh.js**: Install Aiken + Deno + Yaci DevKit

## Results

All test results are stored in `.local-test-results/`:

```
.local-test-results/
├── aiken-examples.txt           # List of discovered Aiken examples
├── ccl-examples.txt             # List of discovered CCL examples
├── mesh-examples.txt            # List of discovered Mesh.js examples
├── lucid-examples.txt           # List of discovered Lucid examples
├── aiken-{example}-check.log    # Aiken check output
├── aiken-{example}-build.log    # Aiken build output
├── aiken-{example}-status.txt   # success/failed
├── ccl-{example}.log            # CCL test output
├── ccl-{example}-status.txt     # success/failed/timeout
├── mesh-{example}.log           # Mesh.js test output
├── mesh-{example}-status.txt    # success/failed/timeout
└── ecosystem-report.md          # Comprehensive report
```

## Viewing Results

### Quick Summary
```bash
cat .local-test-results/ecosystem-report.md
```

### Check Specific Test
```bash
# View Aiken compilation logs
cat .local-test-results/aiken-simple-transfer-build.log

# View CCL test logs
cat .local-test-results/ccl-simple-transfer.log

# View Mesh.js test logs
cat .local-test-results/mesh-payment-splitter.log
```

### Check Test Status
```bash
# See which examples passed/failed
grep -r "success" .local-test-results/*-status.txt
grep -r "failed" .local-test-results/*-status.txt
```

## Troubleshooting

### Yaci DevKit Not Starting
```bash
# Check if it's already running
nc -z localhost 8080

# Check logs
cat .local-test-results/yaci-devkit.log

# Manually start
yaci-devkit up --enable-yaci-store
```

### Aiken Compilation Fails
```bash
# Run manually to see detailed errors
cd {example}/onchain/aiken
aiken check
aiken build
```

### Tests Timeout
- Increase timeout in scripts (default: 300s)
- Check Yaci DevKit is responding: `curl http://localhost:8080`
- Check logs for the specific example

### Clean Start
```bash
# Remove all previous results
rm -rf .local-test-results

# Stop Yaci DevKit
yaci-devkit down

# Re-run tests
./scripts/local-test-all.sh
```

## Relationship to GitHub Actions

### Shared Discovery
The discovery script is **directly called** by GitHub Actions:

```yaml
# .github/workflows/ecosystem-test.yml
jobs:
  discover:
    steps:
      - run: scripts/local-test-discovery.sh  # ← Same script!
```

### Same Commands, Different Execution

**Local (Sequential):**
```bash
# scripts/local-test-aiken.sh
for example in simple-transfer htlc vault; do
  cd $example/onchain/aiken
  aiken check    # ← These commands
  aiken build    # ← Are identical
done
```

**GitHub Actions (Parallel Matrix):**
```yaml
# .github/workflows/ecosystem-test.yml
strategy:
  matrix:
    example: [simple-transfer, htlc, vault]  # Run in parallel
steps:
  - run: |
      cd ${{ matrix.example }}/onchain/aiken
      aiken check    # ← Same commands
      aiken build    # ← As local scripts
```

## Tips

- Run `local-test-discovery.sh` first to see what will be tested
- Use individual scripts during development for faster feedback
- The full test suite can take 5-15 minutes depending on the number of examples
- Check `.local-test-results/ecosystem-report.md` for a comprehensive overview
