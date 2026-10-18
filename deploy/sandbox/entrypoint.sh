#!/bin/sh
# Container entrypoint for the LarkBot sandbox.
#
# Generates the SSH host key once, into the sandbox-host-keys volume, then runs
# sshd in the foreground (-D) logging to stderr (-e). The bot pins this key in
# its known_hosts file (deploy/sandbox-exec), so the volume must survive
# `docker compose up --force-recreate`; only `docker volume rm
# larkbot_sandbox-host-keys` rotates the key, and that requires regenerating
# known_hosts on the bot side.

set -eu

mkdir -p /run/sshd
chmod 0755 /run/sshd

if [ ! -s /etc/ssh/host_keys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/host_keys/ssh_host_ed25519_key
  chmod 0600 /etc/ssh/host_keys/ssh_host_ed25519_key
fi

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
