#!/bin/sh
# entrypoint for the host-test harness. Brings up sshd + vsftpd, then
# execs the Minecraft server JVM as the foreground process so the
# container's lifetime tracks MC's lifetime.
set -eu

log() { printf '[entrypoint %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "boot"

SERVER_DIR=/home/mctest/server
mkdir -p "$SERVER_DIR" /home/mctest/.ssh

log "writing eula.txt"
echo "eula=true" > "$SERVER_DIR/eula.txt"
echo "# accepted automatically by test harness" >> "$SERVER_DIR/eula.txt"

log "rendering server.properties"
sed -e "s|__RCON_PASSWORD__|testpass|" \
    -e "s|__SERVER_PORT__|25565|" \
    /etc/mc/server.properties.tmpl > "$SERVER_DIR/server.properties"
chown -R mctest:mctest "$SERVER_DIR"

log "generating sshd host keys"
ssh-keygen -A

log "provisioning per-user ssh keypair"
if [ ! -f /home/mctest/.ssh/id_ed25519 ]; then
    su -s /bin/sh mctest -c "ssh-keygen -t ed25519 -N '' -f /home/mctest/.ssh/id_ed25519"
    cat /home/mctest/.ssh/id_ed25519.pub > /home/mctest/.ssh/authorized_keys
fi
chmod 700 /home/mctest/.ssh
chmod 600 /home/mctest/.ssh/authorized_keys
chown -R mctest:mctest /home/mctest/.ssh

# Background daemons. sshd/vsftpd live for the lifetime of the
# container; the MC JVM holds the foreground. Daemon failures are
# logged but not fatal — the canonical "ready" signal is MC's RCON
# port binding, which doesn't depend on sshd/vsftpd being up.
log "starting sshd"
/usr/sbin/sshd || echo "[entrypoint] sshd failed to start" >&2
log "starting vsftpd"
/usr/sbin/vsftpd /etc/vsftpd.conf || echo "[entrypoint] vsftpd failed to start" >&2

log "starting minecraft (background)"
cd "$SERVER_DIR"
# Run MC in the background and capture its PID. The entrypoint then
# waits for it. We deliberately do NOT auto-restart: when MC exits
# (e.g. via RCON `stop`), the harness stays up so tests can call
# startServer to bring it back. A restart loop here would race with
# the tests' own start/stop assertions and waste boot time on every
# test run.
#
# Once MC exits, hold PID 1 open with `tail -f /dev/null` so the
# container itself stays alive. Without this, the `exec` approach
# would tie container lifetime to the JVM and any stop would tear
# the harness down — forcing a full image rebuild. Running as root
# in a single-purpose test container is fine; MC doesn't need user
# isolation here.
java \
    -Xms512M -Xmx1024M \
    -jar server.jar nogui &
JAVA_PID=$!
log "minecraft pid=$JAVA_PID"

# Block until MC exits, then hold PID 1 open indefinitely.
wait "$JAVA_PID" 2>/dev/null
log "minecraft exited (pid=$JAVA_PID) — container still alive; tests can restart MC via startServer"
exec tail -f /dev/null