# MRI Experimental Design Planner - hardened Alpine image.
#
# Two stages: the first builds a virtual environment with the pinned
# dependencies, the second carries only that environment, the application and
# a tini init.  The application never runs as root and never needs to write
# anywhere except the mounted data directory, so the container can be started
# with a read-only root filesystem and every capability dropped.
#
#   docker build -t mri-planner .
#   ./dockerRun.sh

ARG PYTHON_IMAGE=python:3.12-alpine

# --------------------------------------------------------------- build stage

FROM ${PYTHON_IMAGE} AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore

# build-base only exists in this stage; it is needed if a dependency has no
# musl wheel and has to be compiled from source.
RUN apk add --no-cache build-base

COPY requirements.txt /tmp/requirements.txt

RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# --------------------------------------------------------------- final stage

FROM ${PYTHON_IMAGE} AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

LABEL org.opencontainers.image.title="MRI Experimental Design Planner" \
      org.opencontainers.image.description="Generic MRI experimental design planner and scanner-time optimiser: trials, runs, sessions, experiments and one budget." \
      org.opencontainers.image.vendor="Wright State University" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.source="https://example.invalid/mri-experimental-design-planner"

# Pick up any security patches published since the base image was cut, and add
# a real init so waitress receives SIGTERM and no zombies accumulate.
RUN apk upgrade --no-cache \
 && apk add --no-cache tini \
 && addgroup -g "${APP_GID}" -S planner \
 && adduser -u "${APP_UID}" -G planner -S -H -s /sbin/nologin planner

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PATH="/opt/venv/bin:${PATH}" \
    HOME=/tmp \
    PLANNER_HOST=0.0.0.0 \
    PLANNER_PORT=8761 \
    PLANNER_PROTOCOL_DIR=/data/scanner-parameters \
    PLANNER_PRESET_DIR=/data/presets \
    PLANNER_EXPORT_DIR=/data/exports \
    PLANNER_SEED_DIR=/app/seed

COPY --from=build /opt/venv /opt/venv

WORKDIR /app

# Application code is owned by root and not writable by the runtime user: the
# process can read its own source and nothing more.
COPY server.py ./
COPY planner ./planner
COPY static ./static
COPY templates ./templates
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The pristine protocol cards ship inside the image and are copied into the
# data directory on first start, so an empty volume still comes up working.
COPY scanner-parameters ./seed/scanner-parameters

# /data itself is world-traversable on purpose: dockerRun.sh starts the
# container as the invoking user's uid so that bind-mounted files stay owned by
# them, and that uid needs to be able to reach the mount points underneath.
# The state directories stay 0770 for the image's own default user, which is
# who owns them when no bind mount is supplied.
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && python -m compileall -q /app/server.py /app/planner \
 && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0755 /data \
 && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0770 \
      /data/scanner-parameters /data/presets /data/exports

VOLUME ["/data"]
EXPOSE 8761

USER ${APP_UID}:${APP_GID}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import os,sys,urllib.request;\
port=os.environ.get('PLANNER_PORT','8761');\
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+port+'/api/health',timeout=4).status==200 else 1)"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []
