# Hook artifact image. It intentionally does not include n8n; use it as an init/one-shot
# container to copy the versioned hook into a shared volume for an official n8n image.
FROM busybox:1.38.0-musl@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6

COPY dist/hook.cjs /hook.cjs
COPY scripts/install-hook.sh /install-hook.sh

ENTRYPOINT ["/install-hook.sh"]
CMD ["/out/hook.cjs"]
