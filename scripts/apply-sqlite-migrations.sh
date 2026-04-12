#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/apply-sqlite-migrations.sh --db PATH --migrations DIR [--label NAME]

Applies SQLite/libSQL-compatible .sql migrations in lexicographic order and records
successful applications in a local schema_migrations table.

Options:
  --db PATH           Target SQLite database file path.
  --migrations DIR    Directory containing .sql migration files.
  --label NAME        Optional logical label stored with each applied migration.
  -h, --help          Show this help text.
EOF
}

db_path=""
migrations_dir=""
label=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      db_path="${2:-}"
      shift 2
      ;;
    --migrations)
      migrations_dir="${2:-}"
      shift 2
      ;;
    --label)
      label="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$db_path" || -z "$migrations_dir" ]]; then
  echo "--db and --migrations are required" >&2
  usage >&2
  exit 1
fi

if [[ ! -d "$migrations_dir" ]]; then
  echo "migrations directory not found: $migrations_dir" >&2
  exit 1
fi

if [[ -z "$label" ]]; then
  label="$(basename "$migrations_dir")"
fi

mkdir -p "$(dirname "$db_path")"

checksum_file() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi

  echo "sha256 tool not available" >&2
  exit 1
}

sql_literal() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

sqlite3 "$db_path" "
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_name TEXT PRIMARY KEY,
    migration_label TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"

applied_count=0
skipped_count=0

while IFS= read -r migration_file; do
  migration_name="$(basename "$migration_file")"
  migration_dir="$(cd "$(dirname "$migration_file")" && pwd)"
  migration_file_abs="$migration_dir/$migration_name"
  checksum="$(checksum_file "$migration_file")"
  existing_checksum="$(
    sqlite3 "$db_path" \
      "SELECT checksum FROM schema_migrations WHERE migration_name = $(sql_literal "$migration_name");"
  )"

  if [[ -n "$existing_checksum" ]]; then
    if [[ "$existing_checksum" != "$checksum" ]]; then
      echo "checksum mismatch for already applied migration: $migration_name" >&2
      exit 1
    fi

    echo "skip  $migration_name"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "apply $migration_name"

  temp_sql="$(mktemp /tmp/pirate-migration.XXXXXX.sql)"
  cat > "$temp_sql" <<SQL
.bail on
BEGIN;
.read $migration_file_abs
INSERT INTO schema_migrations (migration_name, migration_label, checksum)
VALUES ($(sql_literal "$migration_name"), $(sql_literal "$label"), $(sql_literal "$checksum"));
COMMIT;
SQL

  sqlite3 "$db_path" < "$temp_sql"
  rm -f "$temp_sql"

  applied_count=$((applied_count + 1))
done < <(find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' | sort)

echo
echo "migration run complete"
echo "db: $db_path"
echo "label: $label"
echo "applied: $applied_count"
echo "skipped: $skipped_count"
