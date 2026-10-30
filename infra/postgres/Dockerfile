FROM postgres:16-bookworm@sha256:d81f7b51697014367236d07ec58b54153fc28f828b72bf247fe5c7487520bcb0

COPY infra/postgres/requirements.lock /tmp/requirements.lock

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-venv curl \
    && /usr/bin/python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.lock \
    && /opt/venv/bin/pip check \
    && apt-get clean

COPY infra/postgres/patroni.yaml /etc/patroni/patroni.yaml
COPY --chmod=755 infra/postgres/entrypoint.sh /usr/local/bin/billeterie-patroni

ENV PATH="/opt/venv/bin:${PATH}"
ENTRYPOINT ["/usr/local/bin/billeterie-patroni"]
CMD ["/opt/venv/bin/patroni", "/etc/patroni/patroni.yaml"]
