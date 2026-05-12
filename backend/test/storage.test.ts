import { test } from "node:test";
import assert from "node:assert/strict";
import { buildS3Config } from "../src/lib/storage.js";

const SAVED = {
  endpoint: process.env.R2_ENDPOINT_URL,
  region: process.env.R2_REGION,
  pathStyle: process.env.R2_FORCE_PATH_STYLE,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
};

function restoreEnv() {
  process.env.R2_ENDPOINT_URL = SAVED.endpoint;
  process.env.R2_REGION = SAVED.region;
  process.env.R2_FORCE_PATH_STYLE = SAVED.pathStyle;
  process.env.R2_ACCESS_KEY_ID = SAVED.accessKeyId;
  process.env.R2_SECRET_ACCESS_KEY = SAVED.secretAccessKey;
}

test("defaults: region=auto, forcePathStyle=false", () => {
  try {
    process.env.R2_ENDPOINT_URL = "http://garage:3900";
    process.env.R2_ACCESS_KEY_ID = "a";
    process.env.R2_SECRET_ACCESS_KEY = "b";
    delete process.env.R2_REGION;
    delete process.env.R2_FORCE_PATH_STYLE;
    const cfg = buildS3Config();
    assert.equal(cfg.region, "auto");
    assert.equal(cfg.forcePathStyle, false);
    assert.equal(cfg.endpoint, "http://garage:3900");
    assert.equal(cfg.credentials.accessKeyId, "a");
    assert.equal(cfg.credentials.secretAccessKey, "b");
  } finally {
    restoreEnv();
  }
});

test("R2_REGION env overrides default", () => {
  try {
    process.env.R2_ENDPOINT_URL = "https://s3.amazonaws.com";
    process.env.R2_ACCESS_KEY_ID = "a";
    process.env.R2_SECRET_ACCESS_KEY = "b";
    process.env.R2_REGION = "us-east-1";
    const cfg = buildS3Config();
    assert.equal(cfg.region, "us-east-1");
  } finally {
    restoreEnv();
  }
});

test("R2_FORCE_PATH_STYLE=true enables path-style", () => {
  try {
    process.env.R2_ENDPOINT_URL = "http://minio:9000";
    process.env.R2_ACCESS_KEY_ID = "a";
    process.env.R2_SECRET_ACCESS_KEY = "b";
    process.env.R2_FORCE_PATH_STYLE = "true";
    const cfg = buildS3Config();
    assert.equal(cfg.forcePathStyle, true);
  } finally {
    restoreEnv();
  }
});

test("R2_FORCE_PATH_STYLE=anything-else stays false", () => {
  try {
    process.env.R2_ENDPOINT_URL = "http://x:1";
    process.env.R2_ACCESS_KEY_ID = "a";
    process.env.R2_SECRET_ACCESS_KEY = "b";
    process.env.R2_FORCE_PATH_STYLE = "1";
    const cfg = buildS3Config();
    assert.equal(cfg.forcePathStyle, false);
    process.env.R2_FORCE_PATH_STYLE = "yes";
    assert.equal(buildS3Config().forcePathStyle, false);
  } finally {
    restoreEnv();
  }
});
