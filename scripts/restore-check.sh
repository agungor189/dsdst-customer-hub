#!/bin/sh
set -eu
if [ "$#" -lt 2 ]; then echo "usage: restore-check.sh <database.db> <attachments.tar.gz>" >&2; exit 2; fi
node -e "const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true});const result=db.pragma('integrity_check',{simple:true});db.close();if(result!=='ok'){console.error(result);process.exit(1)}" "$1"
tar -tzf "$2" >/dev/null
echo "database=ok attachments=ok"
