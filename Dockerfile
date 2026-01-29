# DustyTrails Dashboard Server
# Multi-stage build for smaller final image

# Build stage - install dependencies
FROM python:3.11-slim as builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# Runtime stage - minimal image
FROM python:3.11-slim

LABEL maintainer="Joshua Parker"
LABEL description="DustyTrails - Real-time air quality monitoring dashboard"

WORKDIR /app

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY dashboard_server.py .
COPY airnow_slc.py .
COPY airnow_api.py .
COPY aqi_breakpoints.csv .

# Copy Python package
COPY mobileair/ ./mobileair/

# Copy static dashboard files
COPY dashboard/ ./dashboard/

# Create data directory (mounted as volume in production)
RUN mkdir -p /data && chown -R nobody:nogroup /data
ENV MOBILEAIR_DATA_DIR=/data

# Run as non-root user
USER nobody

# Expose default port
EXPOSE 8766

# Health check endpoint (uses /api/config as lightweight check)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8766/api/config', timeout=5)" || exit 1

# Default command
CMD ["python", "dashboard_server.py", "--host", "0.0.0.0", "--port", "8766", "--data-mode", "proxy"]
