# syntax=docker/dockerfile:1.7
#
# Test harness image for the SSH/FTP host providers in
# sandstone-cli/src/hosts/providers/. Runs a real Minecraft server
# alongside sshd and vsftpd so the providers are exercised against a
# genuine remote host, not a stand-in.
#
# MC version is pinned via build arg (default 1.21.1). At build time
# the Mojang version manifest is queried for the server.jar URL by
# version id, so the Dockerfile stays readable and version bumps are
# a one-line change.
ARG MC_VERSION=1.21.1

# Java 25 — modern Minecraft needs a modern JVM. eclipse-temurin ships
# JRE-only alpine images, which keeps the final image small (no JDK).
FROM eclipse-temurin:25-jre-alpine

ARG MC_VERSION

RUN apk add --no-cache \
        bash \
        coreutils \
        curl \
        jq \
        ncurses \
        openssh-server \
        screen \
        tmux \
        vsftpd \
    && mkdir -p /run/sshd \
    && adduser -D -h /home/mctest -s /bin/sh mctest \
    && echo "mctest:testpass" | chpasswd \
    && mkdir -p /home/mctest/server /home/mctest/.ssh /etc/mc \
    && chown -R mctest:mctest /home/mctest

# Bake in server.jar at build time.
RUN set -eux; \
    MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"; \
    VERSION_JSON_URL=$(curl -fsSL "$MANIFEST_URL" \
        | jq -r ".versions[] | select(.id==\"${MC_VERSION}\") | .url"); \
    if [ -z "$VERSION_JSON_URL" ] || [ "$VERSION_JSON_URL" = "null" ]; then \
        echo "Mojang manifest did not include version ${MC_VERSION}" >&2; \
        exit 1; \
    fi; \
    SERVER_JAR_URL=$(curl -fsSL "$VERSION_JSON_URL" \
        | jq -r '.downloads.server.url'); \
    if [ -z "$SERVER_JAR_URL" ] || [ "$SERVER_JAR_URL" = "null" ]; then \
        echo "Mojang version JSON had no server.jar for ${MC_VERSION}" >&2; \
        exit 1; \
    fi; \
    curl -fsSL -o /home/mctest/server/server.jar "$SERVER_JAR_URL"; \
    chown mctest:mctest /home/mctest/server/server.jar

COPY sshd_config /etc/ssh/sshd_config
COPY vsftpd.conf /etc/vsftpd.conf
COPY pam_vsftpd /etc/pam.d/vsftpd
COPY server.properties.tmpl /etc/mc/server.properties.tmpl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22 21 25565 25575
EXPOSE 40000-40009

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]