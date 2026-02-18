A Dockerfile that creates an Docker image you can use to compile NEAR smart contracts.

Useful for compiling Shade Agent contracts on mac as it contains a dependency that can't be build on mac.

You can construct your own image or use this image.

```bash
docker run --rm -v "$(pwd)":/workspace pivortex/near-builder@sha256:dad9153f487ec993334d11900b2a9a769c542dd8feecb71c9cd453f29300e156 cargo near build non-reproducible-wasm
```