A Dockerfile that creates an Docker image you can use to compile NEAR smart contracts.

Useful for compiling Shade Agent contracts on mac as it contains a dependency that can't be build on mac.

You can construct your own image or use this image.

```bash
docker run --rm -v "$(pwd)":/workspace pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 cargo near build non-reproducible-wasm
```