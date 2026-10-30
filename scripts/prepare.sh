#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
secrets_dir="${project_dir}/.secrets"
umask 077
if [ -L "${secrets_dir}" ]; then
    printf 'Refus du dossier symbolique : %s\n' "${secrets_dir}" >&2
    exit 1
fi
mkdir -p "${secrets_dir}"
chmod 0700 "${secrets_dir}"

# Le dossier privé protège les fichiers locaux. Le mode 0444 permet leur lecture par Apache dans Docker.
for secret_name in superuser_password replication_password app_password admin_token; do
    secret_path="${secrets_dir}/${secret_name}"
    if [ -L "${secret_path}" ]; then
        printf 'Refus du lien symbolique : %s\n' "${secret_path}" >&2
        exit 1
    fi
    if [ ! -e "${secret_path}" ]; then
        openssl rand -hex 32 > "${secret_path}"
    fi
    if [ ! -f "${secret_path}" ] || [ ! -s "${secret_path}" ]; then
        printf 'Secret absent ou vide : %s\n' "${secret_path}" >&2
        exit 1
    fi
    chmod 0444 "${secret_path}"
done

printf 'Secrets locaux prêts dans %s (valeurs masquées).\n' "${secrets_dir}"
