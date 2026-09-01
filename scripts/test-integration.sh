#!/usr/bin/env bash
set -euo pipefail

for jdk in /opt/homebrew/opt/openjdk /usr/local/opt/openjdk; do
  if [[ -x "$jdk/bin/java" ]]; then
    export JAVA_HOME="$jdk/libexec/openjdk.jdk/Contents/Home"
    export PATH="$jdk/bin:$PATH"
    break
  fi
done

if ! command -v java >/dev/null 2>&1; then
  echo 'Java 21+ is required (brew install openjdk).' >&2
  exit 1
fi

exec npx firebase emulators:exec --project pindom-fn-test --only auth,firestore,storage,functions \
  "node --test functions/test/*.test.mjs"
