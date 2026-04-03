#!/bin/bash

BACKEND_PORT=8000
FRONTEND_PORT=5173
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_ROOT/.dev-pids"
LOCK_FILE="$PROJECT_ROOT/.dev-lock"

# Clean up stale PIDs and lock file on exit
cleanup() {
    echo ""
    echo "Cleaning up..."
    if [ -f "$PID_FILE" ]; then
        while read pid; do
            [ -z "$pid" ] && continue
            if ps -p "$pid" > /dev/null 2>&1; then
                kill "$pid" 2>/dev/null || true
                sleep 0.5
            fi
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    rm -f "$LOCK_FILE"
}

trap cleanup EXIT INT TERM

# Check for existing lock file
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && ps -p "$LOCK_PID" > /dev/null 2>&1; then
        echo "Error: Another instance is already running (PID: $LOCK_PID)"
        echo "If this is incorrect, remove $LOCK_FILE and try again"
        exit 1
    else
        echo "Removing stale lock file..."
        rm -f "$LOCK_FILE"
    fi
fi

# Create lock file with our PID
echo $$ > "$LOCK_FILE"

# Clean up stale PIDs from previous runs
if [ -f "$PID_FILE" ]; then
    TEMP_PID_FILE=$(mktemp)
    while read pid; do
        [ -z "$pid" ] && continue
        if ps -p "$pid" > /dev/null 2>&1; then
            echo "$pid" >> "$TEMP_PID_FILE"
        fi
    done < "$PID_FILE"
    mv -f "$TEMP_PID_FILE" "$PID_FILE" 2>/dev/null || rm -f "$TEMP_PID_FILE"
fi

# Initialize empty PID file
> "$PID_FILE"

kill_port() {
    local port=$1
    local pids=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "Port $port is in use. Stopping existing processes..."
        echo "$pids" | xargs kill -TERM 2>/dev/null || true
        sleep 2
        # Force kill if still running
        pids=$(lsof -ti :$port 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi
    fi
}

check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "Port $port is still in use after cleanup attempt."
        echo "Please run './stop.sh' first or manually kill processes on port $port"
        exit 1
    fi
}

# Clean up any processes on our ports
kill_port $BACKEND_PORT
kill_port $FRONTEND_PORT

# Verify ports are free
check_port $BACKEND_PORT
check_port $FRONTEND_PORT

echo "Starting backend on port $BACKEND_PORT..."
cd "$PROJECT_ROOT/backend"
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt
cd "$PROJECT_ROOT"

# Start uvicorn with proper output redirection
# Use --reload-dir instead of --reload-exclude to only watch backend directory
# This is much faster in Google Drive folders
# Force GCP project to match this repo (.firebaserc) - prevents token verification failures
# when developer's gcloud config points to a different project
export GCP_PROJECT_ID="data-integrity-monitor"
PYTHONPATH="$PROJECT_ROOT" nohup uvicorn backend.main:app \
    --reload \
    --reload-dir "$PROJECT_ROOT/backend" \
    --host 0.0.0.0 \
    --port $BACKEND_PORT \
    > "$PROJECT_ROOT/.backend.log" 2>&1 &
BACKEND_PID=$!

# Wait and verify backend started and is responding
echo "Waiting for backend to be ready..."
BACKEND_READY=false
for i in {1..45}; do
    sleep 1
    # Check if process is still running
    if ! ps -p "$BACKEND_PID" > /dev/null 2>&1; then
        echo "Error: Backend process died unexpectedly. Check .backend.log for details."
        echo ""
        echo "Last 50 lines of log:"
        tail -50 "$PROJECT_ROOT/.backend.log" 2>/dev/null || echo "  (log file empty or not found)"
        exit 1
    fi
    # Check if server is responding
    # Do not use curl -f: /health may return 503 when dependencies fail; server is still up.
    if curl -s --max-time 2 http://localhost:$BACKEND_PORT/health > /dev/null 2>&1; then
        BACKEND_READY=true
        break
    fi
    # Show progress every 5 seconds
    if [ $((i % 5)) -eq 0 ]; then
        echo "  Still waiting... (${i}/45 seconds)"
    fi
done

if [ "$BACKEND_READY" = false ]; then
    echo ""
    echo "Error: Backend failed to start after 45 seconds."
    echo ""
    echo "Process status:"
    ps -p "$BACKEND_PID" 2>/dev/null || echo "  Process not found"
    echo ""
    echo "All uvicorn processes:"
    ps aux | grep -E "uvicorn|python.*main:app" | grep -v grep || echo "  None found"
    echo ""
    echo "Port status:"
    lsof -i :$BACKEND_PORT 2>/dev/null || echo "  Nothing listening on port $BACKEND_PORT"
    echo ""
    echo "Last 50 lines of log:"
    tail -50 "$PROJECT_ROOT/.backend.log" 2>/dev/null || echo "  (log file empty or not found)"
    echo ""
    echo "Troubleshooting:"
    echo "  1. The reloader may be slow in Google Drive folders. Try:"
    echo "     cd backend && source .venv/bin/activate"
    echo "     uvicorn backend.main:app --host 0.0.0.0 --port 8000"
    echo "  2. Check for file system issues (disk space, permissions)"
    echo "  3. Check for Python import errors in the log above"
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
fi

echo "$BACKEND_PID" >> "$PID_FILE"
echo "Backend started and ready (PID: $BACKEND_PID)"

echo "Starting frontend on port $FRONTEND_PORT..."
cd "$PROJECT_ROOT/frontend"
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
fi

VITE_API_BASE="http://localhost:$BACKEND_PORT" npm run dev \
    > "$PROJECT_ROOT/.frontend.log" 2>&1 &
FRONTEND_PID=$!

# Wait and verify frontend started and is responding
echo "Waiting for frontend to be ready..."
FRONTEND_READY=false
for i in {1..20}; do
    sleep 1
    # Check if process is still running
    if ! ps -p "$FRONTEND_PID" > /dev/null 2>&1; then
        echo "Error: Frontend process died unexpectedly. Check .frontend.log for details."
        tail -30 "$PROJECT_ROOT/.frontend.log" 2>/dev/null || true
        exit 1
    fi
    # Check if server is responding
    if curl -s -f http://localhost:$FRONTEND_PORT > /dev/null 2>&1; then
        FRONTEND_READY=true
        break
    fi
done

if [ "$FRONTEND_READY" = false ]; then
    echo "Warning: Frontend may not be fully ready, but process is running."
    echo "Check .frontend.log if you experience issues."
else
    echo "Frontend started and ready (PID: $FRONTEND_PID)"
fi

echo "$FRONTEND_PID" >> "$PID_FILE"

echo ""
echo "Services started:"
echo "  Backend:  http://localhost:$BACKEND_PORT"
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo ""
echo "Streaming backend logs (Press Ctrl+C to stop all services)..."
echo ""

tail -f "$PROJECT_ROOT/.backend.log"
