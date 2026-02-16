# Build stage - use full environment for building everything
FROM ubuntu:24.04 AS builder

# Install all build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl clang llvm build-essential libudev-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install Rust with minimal profile
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain 1.86.0 --profile minimal --no-modify-path \
    && . ~/.cargo/env \
    && rustup target add wasm32-unknown-unknown \
    && curl --proto '=https' --tlsv1.2 -LsSf \
       https://github.com/near/cargo-near/releases/download/cargo-near-v0.16.1/cargo-near-installer.sh | sh

# Runtime stage - minimal Ubuntu for compatibility
FROM ubuntu:24.04 AS runtime

# Install runtime packages including build tools (needed for some crates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    build-essential \
    clang \
    libudev-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && rm -rf /tmp/* /var/tmp/*

# Copy complete Rust toolchain (but clean)
COPY --from=builder /root/.cargo /root/.cargo
COPY --from=builder /root/.rustup /root/.rustup

# Clean up unnecessary files to save space
RUN rm -rf /root/.cargo/registry/cache \
    && rm -rf /root/.cargo/git/db \
    && rm -rf /root/.rustup/downloads \
    && rm -rf /root/.rustup/tmp \
    && find /root/.rustup -name "*.html" -delete \
    && find /root/.rustup -name "*.md" -delete

# Set environment variables
ENV PATH="/root/.cargo/bin:$PATH"
ENV CARGO_HOME=/root/.cargo
ENV RUSTUP_HOME=/root/.rustup
ENV RUST_BACKTRACE=1

WORKDIR /workspace
CMD ["bash"]