#!/bin/sh
trap 'kill 0' EXIT
node_modules/.bin/tsc -p tsconfig.browser.json --watch --preserveWatchOutput &
node_modules/.bin/tsx watch src/server.ts --port 5174
