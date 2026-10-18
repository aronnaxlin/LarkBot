# syntax=docker/dockerfile:1
#
# LarkBot sandbox: the only place LarkBot's Bash tool executes.
#
# The image is a plain Debian userland plus an SSH daemon that accepts exactly
# one key, for exactly one unprivileged user, with no forwarding and no root
# login. The bot reaches it through deploy/sandbox-exec; deploy/firewall.sh
# blocks the sandbox from the host's local networks. No key material is baked
# into the image: the host key is generated on first start into the
# sandbox-host-keys volume, and authorized_keys is a read-only bind mount.
#
# Build (context is deploy/):
#   docker buildx build --platform linux/arm64 -f deploy/sandbox.Dockerfile \
#     -t larkbot-sandbox:arm64 --load deploy/

FROM debian:trixie-slim

# The sandbox user owns only /home/sandbox/work (a named volume at runtime).
# Its passwd home is that directory, so SSH sessions start there and `~` is
# writable while the rest of the root filesystem stays read-only.
#
# sshd (with UsePAM no) refuses logins for an account whose shadow password is
# `!`, so give it an unusable random hash: PasswordAuthentication is off, the
# plaintext is discarded here, and key auth is the only way in.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl git jq openssh-server python3; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/ssh/ssh_host_*; \
    mkdir -p /home/sandbox/work /etc/ssh/authorized_keys /etc/ssh/host_keys; \
    hash=$(openssl passwd -6 "$(openssl rand -hex 32)"); \
    useradd --no-create-home --home-dir /home/sandbox/work --shell /bin/bash --password "$hash" sandbox; \
    chown sandbox:sandbox /home/sandbox/work; \
    chmod 0755 /etc/ssh/authorized_keys; \
    find / -xdev -perm /6000 -type f -exec chmod a-s {} +

# Home is /home/sandbox/work, so SSH sessions start in the one writable
# directory and `~` resolves there while the rest of the root filesystem stays
# read-only at runtime.
COPY sandbox/sshd_config /etc/ssh/sshd_config
COPY sandbox/sandbox-fs /usr/local/bin/sandbox-fs
COPY sandbox/entrypoint.sh /usr/local/bin/sandbox-entrypoint

RUN chmod 0755 /usr/local/bin/sandbox-fs /usr/local/bin/sandbox-entrypoint

# sshd must start as root to bind the port and then drop to `sandbox`; the
# container-level restrictions are cap_drop [ALL] plus the explicit cap_add
# list in deploy/docker-compose.yml.
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
