#!/bin/sh
# init-garage: bootstraps a single-node Garage cluster and creates the
# Mike bucket + access key. Writes R2_ACCESS_KEY_ID/SECRET to /secrets.
set -e

# `garage` CLI reads RPC config from /etc/garage.toml + env (RPC secret).
# Both are mounted/passed in by the compose service.

echo "init-garage: waiting for daemon..."
i=0
until garage status >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-garage: daemon did not respond after 60s" >&2
    exit 1
  fi
  sleep 1
done

# Initialize cluster layout if not already committed.
if ! garage layout show 2>/dev/null | grep -q "Current cluster layout version: [1-9]"; then
  echo "init-garage: assigning cluster layout"
  NODE_ID=$(garage status | awk 'NR>2 && $1 ~ /^[0-9a-f]+$/ { print $1; exit }')
  if [ -z "$NODE_ID" ]; then
    echo "init-garage: could not determine node id from 'garage status'" >&2
    garage status >&2
    exit 1
  fi
  garage layout assign "$NODE_ID" -z dc1 -c 10G
  garage layout apply --version 1
fi

# Create bucket (idempotent).
echo "init-garage: ensuring bucket 'mike'"
garage bucket create mike 2>/dev/null || true

# Create or reuse access key.
echo "init-garage: ensuring key 'mike-key'"
if ! garage key info mike-key >/dev/null 2>&1; then
  garage key create mike-key
fi

# Allow the key to read+write the bucket (idempotent).
garage bucket allow --read --write --owner mike-key mike

# Extract creds and write to the shared secrets volume.
KEY_INFO=$(garage key info mike-key --show-secret)
KEY_ID=$(printf '%s\n' "$KEY_INFO"  | awk -F': *' '/Key ID/    { print $2; exit }')
SECRET=$(printf '%s\n' "$KEY_INFO" | awk -F': *' '/Secret key/ { print $2; exit }')

if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then
  echo "init-garage: failed to parse key info" >&2
  printf '%s\n' "$KEY_INFO" >&2
  exit 1
fi

mkdir -p /secrets
umask 077
cat > /secrets/garage.env <<EOF
R2_ACCESS_KEY_ID=$KEY_ID
R2_SECRET_ACCESS_KEY=$SECRET
EOF

echo "init-garage: complete (creds written to /secrets/garage.env)"
