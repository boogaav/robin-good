#!/bin/bash
# Republish the public dashboard snapshot every 5 minutes.
cd "$(dirname "$0")"
while true; do
  ./publish.sh || echo "publish failed — retrying next cycle"
  sleep 300
done
