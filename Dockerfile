# Hook artifact image. It intentionally does not include n8n; use it as an init/one-shot
# container to copy the versioned hook into a shared volume for an official n8n image.
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092

COPY dist/hook.cjs /hook.cjs
COPY scripts/install-hook.sh /install-hook.sh

ENTRYPOINT ["/install-hook.sh"]
CMD ["/out/hook.cjs"]
