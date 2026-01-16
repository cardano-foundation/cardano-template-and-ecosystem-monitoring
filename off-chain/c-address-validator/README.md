# Cardano Address Format Validator (C Implementation)

## Description
This is a lightweight, dependency-free C implementation designed to validate the structure of Cardano addresses. It focuses on the **Bech32** character set and prefix validation, which is a fundamental step for any off-chain tool interacting with the Cardano blockchain.

In the Cardano ecosystem, addresses (like `addr1...`) use the Bech32 encoding. This utility ensures that a given string adheres to the basic syntax requirements of a Cardano Mainnet address, preventing common entry errors before further processing.

## Use Case
**Off-chain Utility / Developer Tooling**
This implementation is ideal for:
- **Low-level systems:** Integration with hardware or embedded devices (IoT).
- **Validation Layers:** A fast pre-processing step for exchanges or backend services.
- **Educational purposes:** A clear, minimal reference for developers learning about Cardano's address structure.

## Technical Details
- **Language:** C (C99 compatible)
- **Frameworks:** None (Standard Library only)
- **Memory footprint:** Minimal (Stack-based, no dynamic allocation).

### Design Decisions
- **Portability:** Written in standard C to ensure it can run on any operating system or micro-controller.
- **Simplicity:** The code avoids complex polynomial checksums to remain readable for newcomers, focusing on character set validation and prefix identification.

## How to Build and Run

### Prerequisites
You only need a C compiler (like `gcc`, `clang`, or `msvc`).

### Compilation
Open your terminal and run:
```bash
gcc main.c -o address_validator
