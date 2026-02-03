# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app/tests-in-tee/test-image
COPY tests-in-tee/test-image/package.json tests-in-tee/test-image/package-lock.json ./
# Copy shade-agent-js package so npm can link to it (package.json expects file:../../shade-agent-js)
COPY shade-agent-js/package.json shade-agent-js/package-lock.json /app/shade-agent-js/
COPY shade-agent-js/dist /app/shade-agent-js/dist
# Install shade-agent-js dependencies first
WORKDIR /app/shade-agent-js
RUN npm ci --omit=dev
# Install test-image dependencies
WORKDIR /app/tests-in-tee/test-image
RUN npm ci

# Stage 2: Build
FROM node:22-alpine AS builder
WORKDIR /app/tests-in-tee/test-image
COPY tests-in-tee/test-image/package.json tests-in-tee/test-image/package-lock.json tests-in-tee/test-image/tsconfig.json ./
# Copy shade-agent-js package and source files so TypeScript can resolve imports
COPY shade-agent-js/package.json shade-agent-js/package-lock.json /app/shade-agent-js/
COPY shade-agent-js/dist /app/shade-agent-js/dist
COPY shade-agent-js/src /app/shade-agent-js/src
RUN npm ci
COPY tests-in-tee/test-image/src/ ./src/
RUN npm run build

# Stage 3: Production
FROM node:22-alpine AS runner
WORKDIR /app/tests-in-tee/test-image
COPY --from=deps /app/tests-in-tee/test-image/node_modules ./node_modules
COPY --from=builder /app/tests-in-tee/test-image/dist ./dist
COPY tests-in-tee/test-image/package.json ./
# Copy shade-agent-js package and its node_modules so dependencies are available
COPY --from=deps /app/shade-agent-js/dist /app/shade-agent-js/dist
COPY --from=deps /app/shade-agent-js/package.json /app/shade-agent-js/
COPY --from=deps /app/shade-agent-js/node_modules /app/shade-agent-js/node_modules
CMD ["npm", "start"]
