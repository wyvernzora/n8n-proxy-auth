# Thin patch over upstream n8n. The version lives in an ARG so Renovate (P3) and the
# build tagging (P2) share one source of truth. The exact `ARG N8N_VERSION=...` line
# format is a cross-phase contract — do not reformat it.
ARG N8N_VERSION=2.26.8
FROM n8nio/n8n:${N8N_VERSION}

# The hook is built on the host (pnpm build → dist/hook.cjs) BEFORE docker build; only
# dist/ enters the build context (.dockerignore), so the image carries no dev toolchain.
USER root
COPY dist/hook.cjs /opt/proxy-auth/hook.cjs
ENV EXTERNAL_HOOK_FILES=/opt/proxy-auth/hook.cjs
USER node
