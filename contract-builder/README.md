# NEAR Contract Builder

A Docker image for compiling NEAR smart contracts. Useful for building Shade Agent contracts on macOS, which has a dependency that can't be built natively.

## Building the Image (multi-platform)

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t pivortex/near-builder:latest --push .
```

This pushes a single multi-platform manifest so the image works on both x86 (Linux) and ARM (Apple Silicon) machines.

## Using the Image

Run from inside your contract directory:

```bash
docker run --rm -v "$(pwd)":/workspace pivortex/near-builder:latest cargo near build non-reproducible-wasm --no-abi
```

Or from the repository root (needed when the contract has path dependencies like `shade-attestation`):

```bash
docker run --rm -v "$(pwd)":/workspace -w /workspace/shade-contract-template pivortex/near-builder:latest cargo near build non-reproducible-wasm --no-abi
```
