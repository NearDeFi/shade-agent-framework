# Stage 1: Dependencies
FROM node:22-alpine AS deps
# Set up directory structure to match file:../../shade-agent-js path
# package.json is at tests-in-tee/test-image/, so ../../ goes to root, then shade-agent-js
WORKDIR /app/tests-in-tee/test-image
COPY tests-in-tee/test-image/package.json tests-in-tee/test-image/package-lock.json ./
# Copy built shade-agent-js package so npm can link to it (package.json expects file:../../shade-agent-js)
COPY shade-agent-js/dist /app/shade-agent-js/dist
COPY shade-agent-js/package.json shade-agent-js/package-lock.json /app/shade-agent-js/
# Install shade-agent-js dependencies
WORKDIR /app/shade-agent-js
RUN npm ci --only=production
# Install test-image dependencies
WORKDIR /app/tests-in-tee/test-image
RUN npm ci --only=production

# Stage 2: Build
FROM node:22-alpine AS builder
# Set up directory structure to match file:../../shade-agent-js path
WORKDIR /app/tests-in-tee/test-image
COPY tests-in-tee/test-image/package.json tests-in-tee/test-image/package-lock.json tests-in-tee/test-image/tsconfig.json ./
# Copy built shade-agent-js package so npm can link to it (package.json expects file:../../shade-agent-js)
COPY shade-agent-js/dist /app/shade-agent-js/dist
COPY shade-agent-js/package.json shade-agent-js/package-lock.json /app/shade-agent-js/
# Install shade-agent-js dependencies
WORKDIR /app/shade-agent-js
RUN npm ci --only=production
# Install test-image dependencies
WORKDIR /app/tests-in-tee/test-image
RUN npm ci --include=dev
COPY tests-in-tee/test-image/src/ ./src/
RUN npm run build

# Stage 3: Production
FROM node:22-alpine AS runner
WORKDIR /app/tests-in-tee/test-image
COPY --from=deps /app/tests-in-tee/test-image/node_modules ./node_modules
COPY --from=builder /app/tests-in-tee/test-image/dist ./dist
COPY --from=builder /app/tests-in-tee/test-image/package.json ./
# Copy shade-agent-js package and its node_modules so the file:../../shade-agent-js dependency can be resolved
COPY --from=deps /app/shade-agent-js/dist /app/shade-agent-js/dist
COPY --from=deps /app/shade-agent-js/package.json /app/shade-agent-js/
COPY --from=deps /app/shade-agent-js/node_modules /app/shade-agent-js/node_modules
CMD ["npm", "start"]
