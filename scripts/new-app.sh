#!/usr/bin/env bash
# Create a new app in ~/Developer from this template.
# Usage: scripts/new-app.sh <folder-name> "<Display Name>"
set -euo pipefail
template="$(cd "$(dirname "$0")/.." && pwd)"
slug=${1:?Usage: new-app.sh <folder-name> "<Display Name>"}
display=${2:?Usage: new-app.sh <folder-name> "<Display Name>"}

[[ $slug =~ ^[a-z][a-z0-9-]*$ ]] || { echo "folder-name must use lowercase letters, digits and dashes" >&2; exit 1; }
[[ $display =~ ^[A-Za-z0-9\ ]+$ ]] || { echo "Display Name must use letters, digits and spaces" >&2; exit 1; }
dest="${NEW_APP_ROOT:-$HOME/Developer}/$slug"
[[ ! -e $dest ]] || { echo "$dest already exists" >&2; exit 1; }
id=${slug//-/}

rsync -a --exclude node_modules --exclude ios --exclude android --exclude .git --exclude artifacts --exclude .expo \
  "$template/" "$dest/"
cd "$dest"

sed -i '' -e "s/mobilestarter/$id/g" -e "s/slug: 'mobile-starter'/slug: '$slug'/" \
  -e "s/'Starter Dev'/'$display Dev'/" -e "s/'Starter Preview'/'$display Preview'/" \
  -e "s/name: 'Starter',/name: '$display',/" app.config.ts
sed -i '' "s/\"mobile-starter\"/\"$slug\"/g" package.json package-lock.json
sed -i '' "1s/.*/# $display/" CLAUDE.md

cat >docs/SPEC.md <<EOF
# $display — Product Spec

## Purpose
TBD

## Users
TBD

## Features and acceptance criteria
TBD

## Out of scope
TBD
EOF

cat >docs/CURRENT.md <<EOF
# Current State

**Milestone:** Project created from mobile-starter template
**Completed:** Template demo (home, form, settings, SQLite, theme, notification, Maestro smoke tests)
**Active:** Define product in docs/SPEC.md
**Known issues:** None
**Next:** Replace demo screens with the first real feature
**Latest verification:** Not yet run in this project
EOF

npm ci --silent
git init -q
git add -A
git commit -qm "Create $display from mobile-starter template"
echo "Created $dest"
