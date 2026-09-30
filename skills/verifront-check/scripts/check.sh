#!/usr/bin/env bash
# verifront check 를 부른다. 작업 폴더에 설치된 verifront 만 쓴다.
# npm 에서 받아 오지 않는다. 같은 이름의 다른 패키지를 받을 수 있다
set -u

if [ $# -ne 1 ]; then
  echo "사용법: check.sh <html 파일>" >&2
  exit 2
fi

if ! npx --no-install verifront --version >/dev/null 2>&1; then
  echo "verifront 가 작업 폴더에 설치되어 있지 않다. 사용자에게 설치를 요청한다" >&2
  exit 2
fi

npx --no-install verifront check "$1"
