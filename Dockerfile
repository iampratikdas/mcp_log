# Use official lightweight Node.js 22 LTS on Alpine Linux
FROM node:22-alpine

# Set working directory inside container
WORKDIR /app

# Set environment defaults
ENV NODE_ENV=production \
    PORT=3000

# Copy package manifests first for optimal Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy application source files
COPY src/ ./src/

# Ensure container runs with least-privilege non-root user
USER node

# Expose default HTTP/MCP port
EXPOSE 3000

# Built-in container health check hitting the /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Launch the server
CMD ["node", "src/server.js"]
