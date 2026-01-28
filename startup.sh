#!/bin/bash

set -e

echo "🛑 Stopping existing containers..."
docker compose down

echo "🧹 Removing old cloudflared container if exists..."
docker rm -f cloudflared-driving-bot || true

echo "🚀 Building and starting containers..."
docker compose up -d --build

echo "📡 Waiting for driving-bot container to be ready..."
sleep 2

echo "📜 Attaching live logs for driving-bot (Ctrl+C to detach)..."
docker logs -f driving-bot