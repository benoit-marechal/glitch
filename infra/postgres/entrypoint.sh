#!/bin/sh
set -eu

# Les volumes neufs appartiennent à root. Patroni et PostgreSQL s'exécutent ensuite sous postgres.
install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/data/pgdata
install -d -o postgres -g postgres -m 0775 /var/run/postgresql
chown postgres:postgres /var/lib/postgresql/data

# Les secrets sont lus dans le conteneur et ne figurent pas dans la configuration Compose.
export PATRONI_SUPERUSER_PASSWORD="$(cat /run/secrets/superuser_password)"
export PATRONI_REPLICATION_PASSWORD="$(cat /run/secrets/replication_password)"

exec gosu postgres "$@"
