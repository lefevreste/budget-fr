#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'budget-fr-delivery: %s\n' "$1" >&2
  exit 1
}

normalize_github_repo() {
  local url=${1%.git}

  case "$url" in
    https://github.com/*)
      printf '%s\n' "${url#https://github.com/}"
      ;;
    git@github.com:*)
      printf '%s\n' "${url#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      printf '%s\n' "${url#ssh://git@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail 'not inside a Git repository'
cd "$repo_root"

branch=$(git branch --show-current)
[[ -n "$branch" ]] || fail 'detached HEAD is not deliverable'
[[ "$branch" != 'master' ]] || fail 'delivery directly from master is forbidden'

origin_fetch_url=$(git remote get-url origin 2>/dev/null) ||
  fail 'origin remote is missing'
origin_push_url=$(git remote get-url --push origin 2>/dev/null) ||
  fail 'origin push URL is missing'
upstream_fetch_url=$(git remote get-url upstream 2>/dev/null) ||
  fail 'upstream remote is missing'
upstream_push_url=$(git remote get-url --push upstream 2>/dev/null) ||
  fail 'upstream push URL is missing'

origin_fetch_repo=$(normalize_github_repo "$origin_fetch_url") ||
  fail "unsupported origin fetch URL: $origin_fetch_url"
origin_push_repo=$(normalize_github_repo "$origin_push_url") ||
  fail "unsupported origin push URL: $origin_push_url"
upstream_fetch_repo=$(normalize_github_repo "$upstream_fetch_url") ||
  fail "unsupported upstream fetch URL: $upstream_fetch_url"
upstream_push_repo=$(normalize_github_repo "$upstream_push_url") ||
  fail "unsupported upstream push URL: $upstream_push_url"

[[ "$origin_fetch_repo" == 'lefevreste/budget-fr' ]] ||
  fail "origin fetch must be lefevreste/budget-fr, got $origin_fetch_repo"
[[ "$origin_push_repo" == 'lefevreste/budget-fr' ]] ||
  fail "origin push must be lefevreste/budget-fr, got $origin_push_repo"
[[ "$upstream_fetch_repo" == 'actualbudget/actual' ]] ||
  fail "upstream fetch must be actualbudget/actual, got $upstream_fetch_repo"
[[ "$upstream_push_repo" == 'actualbudget/actual' ]] ||
  fail "upstream push configuration must be actualbudget/actual, got $upstream_push_repo"

printf 'branch: %s\n' "$branch"
printf 'origin: %s (fetch), %s (push)\n' "$origin_fetch_repo" "$origin_push_repo"
printf 'upstream: %s (read/update only; never push)\n' "$upstream_fetch_repo"
printf '%s\n' 'working tree:'
git status --short --branch
