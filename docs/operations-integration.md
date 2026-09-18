# dsdst-operations entegrasyonu

Operations deposu bu çalışma alanında bulunmadığından aşağıdaki değişiklikler bu repoda uygulanmadı. `compose.prod.example.yml` kopyalanmak yerine mevcut Operations compose düzenine uyarlanmalıdır.

## Gerekli değişiklikler

- `compose.prod.yml`: `dsdst-customer-hub` servisi; `edge` + `internal`, read-only root, `/tmp` tmpfs, `/data` persistent mount ve healthcheck.
- `.env.example`: `CUSTOMER_HUB_PORT`, `CUSTOMER_HUB_DATA_DIR`, `CUSTOMER_HUB_APP_ORIGIN`, `CUSTOMER_HUB_ENCRYPTION_KEY`, Meta secret/verify token.
- `compose.e2e.yml`: Panel test servisi, Hub mock modu ve `GET /api/health` doğrulaması. Mock modu production compose'a taşınmamalı.
- `healthcheck.sh`: Hub health response'unda `status=ok`, `database=ok`, `worker=ok` kontrolü; Panel `degraded` olduğunda Hub inbox health'i düşürülmemeli.
- `backup.sh`: container içinde `/app/scripts/backup.sh`; DB online backup + attachment tar.
- `restore-check.sh`: `/app/scripts/restore-check.sh`; DB `PRAGMA integrity_check` + `tar -tzf`.

Önerilen production service bloğu bu reponun `compose.prod.example.yml` dosyasındadır. Panel DNS adı `panel` değilse `PANEL_BASE_URL` mevcut service adına göre değiştirilmelidir.
