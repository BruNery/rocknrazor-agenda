#!/usr/bin/env bash
# Arranca (se preciso) o Postgres local de testes na porta 5544 e garante a base "rr".
set -e
D=${PGDATA_RR:-/tmp/pgdata_rr}; BIN=/usr/lib/postgresql/16/bin
if pg_isready -q -h /tmp -p 5544; then exit 0; fi
if [ ! -d "$D/base" ]; then mkdir -p "$D"; chown postgres "$D"; su postgres -c "$BIN/initdb -D $D -A trust >/dev/null"; fi
su postgres -c "$BIN/pg_ctl -D $D -o '-p 5544 -k /tmp' -l /tmp/pg_rr.log -w start" >/dev/null
psql -h /tmp -p 5544 -U postgres -tc "select 1 from pg_database where datname='rr'" | grep -q 1 || psql -h /tmp -p 5544 -U postgres -c "create database rr" >/dev/null
