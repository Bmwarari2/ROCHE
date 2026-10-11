# Local development Postgres for Harbour: Postgres 17 with pgAudit, configured like RDS
# (logical replication for PowerSync, pgAudit DDL/role/write logging, SCRAM passwords).
# Used by docker-compose.yml only; AWS environments use RDS (infra/modules/rds_postgres).

FROM postgres:17.11-trixie

# The official image already trusts the PGDG apt repository (apt.postgresql.org), from which
# it installs Postgres itself; pgAudit for Postgres 17 comes from the same repository.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-pgaudit"; \
    rm -rf /var/lib/apt/lists/*

COPY postgresql.conf harbour.conf /etc/postgresql/
COPY initdb/ /docker-entrypoint-initdb.d/

HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=10 \
    CMD ["sh", "-c", "pg_isready -U \"${POSTGRES_USER:-postgres}\" -d \"${POSTGRES_DB:-postgres}\""]

# Run as the postgres user (the data volume is created owned by it); never as root.
USER postgres

CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
