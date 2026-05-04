# Multi-stage: copy the /garage binary into alpine so init-garage.sh has both
# a POSIX shell and the garage CLI available.
FROM dxflrs/garage:v2.3.0 AS garage-bin
FROM alpine:3.20
COPY --from=garage-bin /garage /usr/local/bin/garage
