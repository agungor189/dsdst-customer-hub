#!/bin/sh
set -eu
node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/api/health').then(r => { if (!r.ok) process.exit(1); return r.json(); }).then(v => { if (v.database !== 'ok') process.exit(1); }).catch(() => process.exit(1))"
