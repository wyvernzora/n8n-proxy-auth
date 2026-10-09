# Hook artifact image. It intentionally does not include n8n; use it as an init/one-shot
# container to copy the versioned hook into a shared volume for an official n8n image.
FROM busybox:1.38.0-musl@sha256:ea2b9914a16a4ac1981994af97b318f7c7d4db76b580c56177f08bf76f4a0be8

COPY dist/hook.cjs /hook.cjs
COPY scripts/install-hook.sh /install-hook.sh

ENTRYPOINT ["/install-hook.sh"]
CMD ["/out/hook.cjs"]
