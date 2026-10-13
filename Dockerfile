# Use official lightweight Node.js 22 LTS on Alpine Linux
FROM node:22-alpine

# Set working directory inside container
WORKDIR /app

# Set environment defaults (Cloud Run injects PORT=8080 by default)
ENV NODE_ENV=production \
    PORT=8080

# Copy package manifests first for optimal Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy application source files
COPY src/ ./src/

# Ensure container runs with least-privilege non-root user
USER node

# Expose default Cloud Run / HTTP port
EXPOSE 8080

# Built-in container health check hitting the /health route dynamically via $PORT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-8080}/health || exit 1

# Launch the server (inherits SIGTERM and SIGINT for Cloud Run graceful shutdown)
CMD ["node", "src/server.js"]
