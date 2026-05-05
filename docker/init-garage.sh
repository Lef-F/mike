#!/bin/sh
# init-garage: bootstraps a single-node Garage cluster and creates the
# Mike bucket + access key using the Garage v2 HTTP admin API.
# Writes R2_ACCESS_KEY_ID/SECRET to /secrets/garage.env.
set -e

ADMIN_URL="http://${GARAGE_RPC_HOST%:*}:3903"
AUTH="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"

# Helper: fetch URL and compact JSON (strip whitespace) for reliable grep parsing.
api_get() { wget -qO- --header="$AUTH" "$ADMIN_URL/$1" | tr -d ' \n\t'; }
api_post() {
  local path="$1" body="$2"
  wget -qO- --header="$AUTH" --header="Content-Type: application/json" \
    --post-data="$body" "$ADMIN_URL/$path" | tr -d ' \n\t'
}

echo "init-garage: waiting for admin API..."
i=0
until api_get "v2/GetClusterStatus" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-garage: admin API did not respond after 60s" >&2
    exit 1
  fi
  sleep 1
done
echo "init-garage: admin API is up"

# Initialize cluster layout if version is still 0 (i.e. no layout committed yet).
LAYOUT_VERSION=$(api_get "v2/GetClusterLayout" | grep -o '"version":[0-9]*' | head -1 | grep -o '[0-9]*')
if [ "${LAYOUT_VERSION:-0}" = "0" ]; then
  echo "init-garage: assigning cluster layout"
  NODE_ID=$(api_get "v2/GetClusterStatus" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
  if [ -z "$NODE_ID" ]; then
    echo "init-garage: could not determine node ID" >&2
    exit 1
  fi
  echo "init-garage: node ID is $NODE_ID"
  api_post "v2/UpdateClusterLayout" \
    "{\"roles\":[{\"id\":\"$NODE_ID\",\"zone\":\"dc1\",\"capacity\":10737418240,\"tags\":[]}]}" >/dev/null
  api_post "v2/ApplyClusterLayout" '{"version":1}' >/dev/null
  echo "init-garage: layout applied at version 1"
else
  echo "init-garage: layout already at version $LAYOUT_VERSION, skipping"
fi

# Create bucket (idempotent: skip if alias already exists).
echo "init-garage: ensuring bucket 'mike'"
EXISTING_BUCKET=$(api_get "v2/ListBuckets" | grep -o '"globalAliases":\[[^]]*\]' | grep '"mike"' || true)
if [ -z "$EXISTING_BUCKET" ]; then
  api_post "v2/CreateBucket" '{"globalAlias":"mike"}' >/dev/null
  echo "init-garage: bucket 'mike' created"
else
  echo "init-garage: bucket 'mike' already exists"
fi

# Get bucket ID for allowing the key.
BUCKET_ID=$(api_get "v2/ListBuckets" \
  | sed 's/},{/}\n{/g' | grep '"mike"' \
  | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//')

# Create or reuse access key. GetKeyInfo endpoint requires id + showSecretKey=true.
echo "init-garage: ensuring key 'mike-key'"
EXISTING_KEY_ID=$(api_get "v2/ListKeys" \
  | sed 's/},{/}\n{/g' | grep '"name":"mike-key"' \
  | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//' || true)

if [ -z "$EXISTING_KEY_ID" ]; then
  KEY_JSON=$(api_post "v2/CreateKey" '{"name":"mike-key"}')
  KEY_ID=$(printf '%s' "$KEY_JSON" | grep -o '"accessKeyId":"[^"]*"' | sed 's/"accessKeyId":"//;s/"//')
  SECRET=$(printf '%s' "$KEY_JSON" | grep -o '"secretAccessKey":"[^"]*"' | sed 's/"secretAccessKey":"//;s/"//')
  echo "init-garage: created key $KEY_ID"
else
  KEY_ID="$EXISTING_KEY_ID"
  KEY_JSON=$(api_get "v2/GetKeyInfo?id=$KEY_ID&showSecretKey=true")
  SECRET=$(printf '%s' "$KEY_JSON" | grep -o '"secretAccessKey":"[^"]*"' | sed 's/"secretAccessKey":"//;s/"//')
  echo "init-garage: reusing existing key $KEY_ID"
fi

# Allow the key to read+write the bucket (idempotent — AllowBucketKey is a no-op if already set).
echo "init-garage: granting key access to bucket"
api_post "v2/AllowBucketKey" \
  "{\"bucketId\":\"$BUCKET_ID\",\"accessKeyId\":\"$KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null

if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then
  echo "init-garage: failed to obtain key credentials" >&2
  exit 1
fi

mkdir -p /secrets
umask 077
cat > /secrets/garage.env <<EOF
R2_ACCESS_KEY_ID=$KEY_ID
R2_SECRET_ACCESS_KEY=$SECRET
EOF

echo "init-garage: complete (creds written to /secrets/garage.env)"
