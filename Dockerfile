# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY shade-agent-template/package.json shade-agent-template/package-lock.json ./
# Copy built shade-agent-js package so npm can link to it (package.json expects file:../shade-agent-js)
# Create the parent directory structure and copy the package
RUN mkdir -p /shade-agent-js
COPY shade-agent-js/dist /shade-agent-js/dist
COPY shade-agent-js/package.json shade-agent-js/package-lock.json /shade-agent-js/
# Install shade-agent-js dependencies
WORKDIR /shade-agent-js
RUN npm ci --only=production
# Install shade-agent-template dependencies
WORKDIR /app
RUN npm ci --only=production

# Stage 2: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY shade-agent-template/package.json shade-agent-template/package-lock.json shade-agent-template/tsconfig.json ./
# Copy built shade-agent-js package so npm can link to it (package.json expects file:../shade-agent-js)
# Create the parent directory structure and copy the package
RUN mkdir -p /shade-agent-js
COPY shade-agent-js/dist /shade-agent-js/dist
COPY shade-agent-js/package.json shade-agent-js/package-lock.json /shade-agent-js/
# Install shade-agent-js dependencies
WORKDIR /shade-agent-js
RUN npm ci --only=production
# Install shade-agent-template dependencies
WORKDIR /app
RUN npm ci --include=dev
COPY shade-agent-template/src/ ./src/
RUN npm run build

# Stage 3: Production
FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
# Copy shade-agent-js package and its node_modules so the file:../shade-agent-js dependency can be resolved
RUN mkdir -p /shade-agent-js
COPY --from=deps /shade-agent-js/dist /shade-agent-js/dist
COPY --from=deps /shade-agent-js/package.json /shade-agent-js/
COPY --from=deps /shade-agent-js/node_modules /shade-agent-js/node_modules
CMD ["npm", "start"]

