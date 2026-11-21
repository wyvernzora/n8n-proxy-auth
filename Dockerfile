# Hook artifact image. It intentionally does not include n8n; use it as an init/one-shot
# container to copy the versioned hook into a shared volume for an official n8n image.
FROM busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478

COPY dist/hook.cjs /hook.cjs
COPY scripts/install-hook.sh /install-hook.sh

ENTRYPOINT ["/install-hook.sh"]
CMD ["/out/hook.cjs"]
