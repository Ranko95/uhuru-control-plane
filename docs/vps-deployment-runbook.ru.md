# Control Plane: выполненный деплой и инструкция для следующего VPS

Этот документ записывает развёртывание, выполненное 3 октября 2026 года, и команды для повторения на **новом выделенном VPS**. Команды выполняет администратор в SSH-сессии обычного пользователя с `sudo`. Каждый блок вставляется целиком; после него проверяется результат, затем выполняется следующий блок. Содержимое вывода в команды не вставляется.

Общие требования проекта: [README](../README.md#install-on-a-dedicated-linux-control-plane). Краткая инструкция: [первый деплой на Debian/Ubuntu](vps-deployment.ru.md).

## Что получилось

| Параметр | Значение при этом деплое |
| --- | --- |
| ОС и архитектура | Ubuntu 24.04.5 LTS, x86_64 |
| Ресурсы | 1.9 GiB RAM, 511 MiB swap, диск 30 GiB |
| Пользователь администратора | `ranko`, входит в группу `sudo` |
| SSH | Вход по ключу, TCP `48222` |
| Публичный IPv4 | `87.251.77.65` |
| Домен | `control.uhuru.pro` |
| DNS | A-запись на VPS, Cloudflare **DNS only**, без AAAA |
| Репозиторий | Приватный `Ranko95/uhuru-control-plane`, ветка `main` |
| Развёрнутый коммит | `1a9d8f6` — `add nvmrc and hostname` |
| Каталог исходников | `/opt/uhuru`, владелец `root` |
| Node.js / npm | `v24.21.0` / `11.19.0`, установка в `/usr/local` |
| PostgreSQL | `16`, кластер `main`, база и роль `uhuru` |
| Сервисный пользователь | `uhuru`, без домашнего каталога и входа в shell |
| Настройки | `/etc/uhuru/settings.json`, `640 root:uhuru` |
| systemd | `uhuru-control-plane.service`, автозапуск включён |
| HTTPS | nginx + сертификат Let's Encrypt, продление через `certbot.timer` |

Схема соединений:

```text
Администратор / Node Agent / клиент
  → HTTPS control.uhuru.pro:443 (nginx)
  → HTTP 127.0.0.1:8080 (Control Plane)
  → Unix socket /var/run/postgresql (PostgreSQL)
```

Снаружи доступны SSH `48222`, HTTP `80` для ACME и HTTPS `443`. Приложение слушает только `127.0.0.1:8080`; PostgreSQL не слушает TCP. `/admin` — API с Basic Auth, браузерного интерфейса в проекте нет. Регистрация и настройка VPN-ноды в этот деплой не входили.

## 1. Проверить VPS и DNS

На другом VPS замените IP, домен, SSH-порт, архитектуру и версию/имя кластера PostgreSQL на фактические. Все команды ниже рассчитаны на значения из таблицы. Если используете другой домен, замените его во всех блоках, включая создание JSON-настроек и проверку HTTPS.

```sh
id
cat /etc/os-release
uname -m
free -h
df -h /
command -v git
sudo ss -ltnp
sudo ufw status verbose
cat /proc/sys/kernel/core_pattern
```

До появления секретов отключите в панели провайдера автоматические бэкапы и снимки диска. При нашем деплое это было сделано и подтверждено. Требования к копиям данных описаны в [README](../README.md#storage-and-copies).

В DNS у `control.uhuru.pro` должна быть A-запись на IP VPS. При нашем деплое запись первоначально была проксирована Cloudflare; мы переключили её в **DNS only** (серое облако). AAAA не добавляли. Если AAAA уже существует, она должна указывать на работающий IPv6 этого VPS.

В firewall провайдера разрешите входящие TCP `48222`, `80`, `443`. Не открывайте `8080` и `5432`.

## 2. Установить пакеты

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils git nginx certbot postgresql
pg_lsclusters
```

На нашем VPS получился кластер `16 main`, статус `online`. Следующие пути и имя systemd-unit относятся именно к нему. На новом VPS ориентируйтесь на результат `pg_lsclusters`.

## 3. Отключить сбор core dumps

README требует запрета core dumps у приложения и PostgreSQL, а также `core_pattern` без обработчика через pipe. Изначально Ubuntu использовала обработчик Apport с `|` в начале.

```sh
sudo bash <<'SH'
set -eu
sed -i 's/^enabled=.*/enabled=0/' /etc/default/apport
systemctl mask --now apport.service

cat > /etc/sysctl.d/99-uhuru-no-core.conf <<'CONF'
kernel.core_pattern = core
CONF
sysctl -p /etc/sysctl.d/99-uhuru-no-core.conf

install -d -m 0755 /etc/systemd/system/postgresql@16-main.service.d
cat > /etc/systemd/system/postgresql@16-main.service.d/no-core.conf <<'CONF'
[Service]
LimitCORE=0
CONF
systemctl daemon-reload
systemctl restart postgresql@16-main.service
SH
```

Проверка:

```sh
cat /proc/sys/kernel/core_pattern
systemctl show postgresql@16-main.service -p LimitCORE -p LimitCORESoft
pg_lsclusters
```

Получили `core`, `LimitCORE=0`, `LimitCORESoft=0`; кластер остался `online`. У Control Plane `LimitCORE=0` уже задан в unit из репозитория.

## 4. Подготовить PostgreSQL до загрузки секретов

Настройка предназначена для выделенного кластера Control Plane. Она выключает TCP, журналы SQL/параметров/обычных ошибок, предварительно загружаемые расширения и архивирование WAL. Содержимое соответствует [шаблону проекта](../deploy/postgresql-secrets.conf).

```sh
sudo bash <<'SH'
set -eu
cat > /etc/postgresql/16/main/conf.d/uhuru-secrets.conf <<'CONF'
listen_addresses = ''
log_statement = 'none'
log_min_messages = panic
log_min_error_statement = panic
log_error_verbosity = terse
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
log_min_duration_statement = -1
log_min_duration_sample = -1
log_transaction_sample_rate = 0
log_duration = off
log_connections = off
log_disconnections = off
shared_preload_libraries = ''
session_preload_libraries = ''
local_preload_libraries = ''
archive_mode = off
CONF
chmod 0700 /var/lib/postgresql/16/main /var/lib/postgresql/16/main/pg_wal
systemctl restart postgresql@16-main.service
SH
```

Проверка действующих настроек и прав:

```sh
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -c "SELECT name, setting FROM pg_settings WHERE name IN ('archive_mode', 'listen_addresses', 'log_min_error_statement', 'log_min_messages', 'log_statement', 'shared_preload_libraries') ORDER BY name;"
sudo sed -n '/^[[:space:]]*local[[:space:]]/p' /etc/postgresql/16/main/pg_hba.conf
sudo stat -c '%a %U:%G %n' /var/lib/postgresql/16/main /var/lib/postgresql/16/main/pg_wal
sudo ss -ltnp
```

Подтверждено: `archive_mode=off`, `listen_addresses` пустое, `log_min_error_statement=panic`, `log_min_messages=panic`, `log_statement=none`, `shared_preload_libraries` пустое. Каталоги данных и WAL — `700 postgres:postgres`; TCP `5432` отсутствует.

В нашем `pg_hba.conf` уже были правила `local all postgres peer`, `local all all peer`, `local replication all peer`. Приложение использует локальную peer-аутентификацию от системного пользователя `uhuru`; пароль БД и TCP-правила не добавляли. Если правила на новом хосте другие, сначала приведите локальную аутентификацию к требованиям README.

## 5. Установить Node.js в системный каталог

Установили официальный архив `v24.21.0` с проверкой SHA-256. Это зафиксированная версия нашего деплоя; проект требует Node.js 24.11+ в линейке 24.x. Значение `.nvmrc` в развёрнутом коммите — `v24.11.0`.

```sh
sudo bash <<'SH'
set -eu
uhuru_node_dir=$(mktemp -d)
trap 'rm -rf "$uhuru_node_dir"' EXIT
cd "$uhuru_node_dir"

curl --fail --show-error --location --output node-v24.21.0-linux-x64.tar.xz \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
curl --fail --show-error --location --output SHASUMS256.txt \
  https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
grep '  node-v24.21.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check -
tar -xJf node-v24.21.0-linux-x64.tar.xz -C /usr/local \
  --strip-components=1 --no-same-owner
/usr/local/bin/node -v
/usr/local/bin/npm -v
SH
```

Получили `node-v24.21.0-linux-x64.tar.xz: OK`, `v24.21.0`, `11.19.0`.

`nvm` для сервиса не использовали: он устанавливает Node в домашний каталог пользователя, а unit запускает `/usr/local/bin/node` от отдельного пользователя `uhuru` и включает `ProtectHome=true`.

## 6. Настроить доступ к приватному репозиторию

Создали отдельный root deploy key, предназначенный для чтения этого репозитория. Пользовательский SSH-ключ для входа на VPS — отдельный ключ.

```sh
sudo install -d -m 0700 /root/.ssh
sudo ssh-keygen -t ed25519 -N '' \
  -C 'control-plane-vps' \
  -f /root/.ssh/uhuru-control-plane-github
sudo cat /root/.ssh/uhuru-control-plane-github.pub
```

В GitHub: репозиторий `Ranko95/uhuru-control-plane` → **Settings → Deploy keys → Add deploy key**. Название `control-plane-vps`, содержимое — только публичный ключ `.pub`. **Allow write access** оставили выключенным. Приватный файл не выводите и не копируйте в чат. Генерацию не повторяйте поверх существующего ключа.

Проверка:

```sh
sudo ssh -i /root/.ssh/uhuru-control-plane-github \
  -o IdentitiesOnly=yes -o HostKeyAlgorithms=ssh-ed25519 -T git@github.com
```

При первом подключении сверили отпечаток хоста с [официальными отпечатками GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints), затем подтвердили его. Во время деплоя Ed25519-отпечаток был `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`; при следующем развёртывании сверьте актуальную страницу.

Успешный ответ: `Hi Ranko95/uhuru-control-plane! You've successfully authenticated, but GitHub does not provide shell access.` Эта проверка может завершиться кодом `1` даже при успешной аутентификации: GitHub не предоставляет shell.

Клонирование на новый VPS:

```sh
sudo git clone --branch main \
  --config 'core.sshCommand=ssh -i /root/.ssh/uhuru-control-plane-github -o IdentitiesOnly=yes' \
  git@github.com:Ranko95/uhuru-control-plane.git /opt/uhuru
sudo git -C /opt/uhuru log -1 --oneline
```

Мы получили `1a9d8f6`. На следующем деплое `main` может содержать другой коммит: зафиксируйте фактически установленный коммит. `core.sshCommand` сохраняется в локальной конфигурации клона. Исходники принадлежат `root`; сервисному пользователю право записи не предоставляли.

## 7. Создать сервисного пользователя и установить зависимости

```sh
sudo bash <<'SH'
set -eu
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin uhuru
install -d -o root -g uhuru -m 0750 /etc/uhuru
cd /opt/uhuru
/usr/local/bin/npm ci --omit=dev --ignore-scripts
id uhuru
SH
```

Получили 62 установленных пакета; пользователь `uhuru` — uid `999`, gid `988`. Числовые идентификаторы на другом VPS могут отличаться. Если пользователь уже существует, не повторяйте `useradd`.

### Отложенная уязвимость зависимости

При установке `npm audit` показал одну уязвимость умеренной тяжести в `fast-uri` (версии `3.1.7` и `4.1.4` в дереве зависимостей):

- [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj).
- [GHSA-jvvf-x445-j334](https://github.com/advisories/GHSA-jvvf-x445-j334).

Проверяли командой:

```sh
sudo bash <<'SH'
set -eu
cd /opt/uhuru
/usr/local/bin/npm audit --omit=dev
SH
```

**По решению администратора исправление отложили.** `npm audit fix` на VPS не выполняли; изменения зависимостей и lockfile в этот деплой не вошли. `npm audit` при обнаружении уязвимостей возвращает ненулевой код. При следующем деплое результат аудита нужно оценить заново.

## 8. Инициализировать новую базу

**Только один раз для новой пустой установки.** Эти команды не предназначены для перезапуска, обновления или восстановления существующего Control Plane.

```sh
sudo bash <<'SH'
set -eu
cd /opt/uhuru
runuser -u postgres -- createdb uhuru
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d uhuru -f schema.sql
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d uhuru -f deploy/app-role.sql
runuser -u uhuru -- psql -X -v ON_ERROR_STOP=1 -d uhuru \
  -c 'SELECT current_user, current_database();'
SH
```

Получили `current_user=uhuru`, `current_database=uhuru`. Владелец базы остаётся `postgres`; роль приложения получает ограниченные права из `deploy/app-role.sql`.

## 9. Поднять временный HTTP-сайт для ACME и открыть firewall

Блок рассчитан на выделенный VPS: он отключает стандартный сайт nginx. Наш SSH работал на `48222`; это правило в UFW уже было разрешено. На новом VPS сначала проверьте реальный SSH-порт, прежде чем менять firewall.

```sh
sudo bash <<'SH'
set -eu
install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge
cat > /etc/nginx/sites-available/uhuru <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name control.uhuru.pro;
    access_log off;
    error_log /dev/null crit;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 404; }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/uhuru /etc/nginx/sites-enabled/uhuru
nginx -t
systemctl enable --now nginx
systemctl reload nginx
ufw allow 80/tcp
ufw allow 443/tcp
ufw status verbose
SH
```

`nginx -t` прошёл. UFW остался активным с политикой `deny incoming`, `allow outgoing`; разрешены `48222/tcp`, `80/tcp`, `443/tcp` для IPv4 и IPv6. UFW был включён до начала работ: этот блок не устанавливает и не включает его с нуля.

Перед выпуском сертификата убедитесь, что публичный DNS уже возвращает IP этого VPS. В нашем случае после переключения Cloudflare некоторое время сохранялся старый DNS-кэш. Ответ `404` временного nginx на обычный HTTP-запрос ожидаем.

## 10. Выпустить сертификат Let's Encrypt

Запускается отдельной интерактивной командой:

```sh
sudo certbot certonly --webroot -w /var/www/letsencrypt -d control.uhuru.pro
```

Администратор ввёл email и принял условия в диалоге Certbot. Получили:

- Сертификат: `/etc/letsencrypt/live/control.uhuru.pro/fullchain.pem`.
- Закрытый ключ: `/etc/letsencrypt/live/control.uhuru.pro/privkey.pem`.
- Объявленная дата окончания первого сертификата: `2027-01-01`; после продления она изменится.

Закрытый ключ остаётся на VPS; в чат его не передавали.

## 11. Установить постоянную конфигурацию nginx

В шаблоне репозитория используется `control.example.com`: заменили его на наш домен, включая пути сертификата.

```sh
sudo bash <<'SH'
set -eu
install -m 0644 /opt/uhuru/deploy/uhuru-control-plane.nginx.conf \
  /etc/nginx/sites-available/uhuru
sed -i 's/control\.example\.com/control.uhuru.pro/g' /etc/nginx/sites-available/uhuru
nginx -t
systemctl reload nginx
SH
```

nginx принимает HTTPS на `443` и передаёт запросы на `127.0.0.1:8080`, сохраняя URL и `Authorization`. На `80` обслуживается только ACME, остальные запросы получают `404`. Журналы этого сайта, proxy cache и буферизация тел выключены согласно шаблону проекта, чтобы секретные URL и тела не сохранялись прокси.

## 12. Настроить автоматическое продление

```sh
sudo bash <<'SH'
set -eu
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-uhuru-nginx <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-uhuru-nginx
systemctl enable --now certbot.timer
SH
```

Проверили продление:

```sh
sudo certbot renew --dry-run
```

Результат: `Congratulations, all simulated renewals succeeded`. Проверка может занять несколько минут. При нашем запуске внутри неинтерактивного блока Certbot задержался на `Processing ...`; в Certbot 2.9 предусмотрена случайная задержка до 8 минут для такого запуска.

Для следующей ручной проверки без случайной задержки, с выполнением deploy hook:

```sh
sudo certbot renew --dry-run --no-random-sleep-on-renew --run-deploy-hooks
```

Последнюю команду при этом деплое не выполняли: первоначальная проверка уже завершилась успешно. Обычный `--dry-run` сам по себе deploy hook не проверяет. Перезагрузка nginx отдельными командами прошла успешно, hook установлен.

## 13. Создать настройки без вывода пароля

Подготовьте уникальный случайный пароль администратора в менеджере паролей, минимум 32 символа для этого блока. Пароль вводится скрыто в терминале; не добавляется в историю shell, аргументы процессов или переменные окружения. Блок создаёт настройки новой установки; не запускайте его для проверки уже существующего файла — он заменит пароль.

```sh
sudo bash <<'SH'
set -eu
ulimit -c 0
umask 077
IFS= read -r -s -p 'Новый пароль admin (минимум 32 символа): ' uhuru_admin_password </dev/tty
printf '\n' >/dev/tty
printf '%s' "$uhuru_admin_password" | /usr/local/bin/node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
process.on("uncaughtException", () => {
  process.stderr.write("settings_creation_failed\n");
  process.exit(1);
});
const password = readFileSync(0, "utf8");
if (password.length < 32) {
  process.stderr.write("password_too_short\n");
  process.exit(1);
}
const settings = JSON.parse(readFileSync("/opt/uhuru/deploy/settings.example.json", "utf8"));
settings.origin = "https://control.uhuru.pro";
settings.port = 8080;
settings.database_socket = "/var/run/postgresql";
settings.admin_username = "admin";
settings.admin_password = password;
writeFileSync("/etc/uhuru/settings.json", JSON.stringify(settings, null, 2) + "\n", { mode: 0o640 });
'
unset uhuru_admin_password
chown root:uhuru /etc/uhuru/settings.json
chmod 0640 /etc/uhuru/settings.json
stat -c '%a %U:%G %n' /etc/uhuru/settings.json
SH
```

Проверенный результат: `640 root:uhuru /etc/uhuru/settings.json`. Пароль не выводили. `origin` — публичный HTTPS без `:8080`; PostgreSQL подключается через Unix socket. Поля `tls_cert`, `tls_key`, `listen_host` не добавляли: HTTPS завершает nginx.

## 14. Установить и запустить systemd-сервис

```sh
sudo bash <<'SH'
set -eu
install -m 0644 /opt/uhuru/deploy/uhuru-control-plane.service \
  /etc/systemd/system/uhuru-control-plane.service
systemctl daemon-reload
systemctl enable --now uhuru-control-plane.service
systemctl status --no-pager --full uhuru-control-plane.service
ss -ltnp | grep -E ':(80|443|8080|5432)\b'
SH
```

Подтверждено: `enabled`, `active (running)`, процесс `/usr/local/bin/node /opt/uhuru/src/server.ts /etc/uhuru/settings.json`. В журнале запуска — фиксированное сообщение `control_plane_started`.

nginx слушает `80` и `443` на IPv4/IPv6; Node — только `127.0.0.1:8080`; TCP `5432` отсутствует. Unit из репозитория ограничивает права процесса, использует `UMask=0077`, `LimitCORE=0`, `ProtectSystem=strict`, `ProtectHome=true`. В нём `Restart=no`: автоматического перезапуска после падения нет, хотя автозапуск при загрузке включён.

## 15. Проверить HTTPS и авторизацию

Без авторизации, по публичному адресу:

```sh
curl --silent --show-error --connect-timeout 5 --max-time 10 \
  --output /dev/null --write-out 'HTTP %{http_code}\n' \
  https://control.uhuru.pro/admin/plan
```

Ожидается `HTTP 401`. Это также проверили с внешнего компьютера: соединение пришло напрямую на `87.251.77.65` и вернуло `401`. С того же внешнего компьютера подключения к TCP `8080` и `5432` завершились тайм-аутом.

Авторизованная проверка на VPS использует временный curl config в `/run` с правами `0600`. Пароль читается из существующих настроек и не выводится; ответ API отбрасывается. `--resolve` направляет запрос к локальному nginx, сохраняя проверку TLS-сертификата для домена:

```sh
sudo bash <<'SH'
set -eu
ulimit -c 0
umask 077
uhuru_check_dir=$(mktemp -d /run/uhuru-admin-check.XXXXXX)
trap 'rm -rf "$uhuru_check_dir"' EXIT

/usr/local/bin/node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
process.on("uncaughtException", () => {
  process.stderr.write("admin_check_failed\n");
  process.exit(1);
});
const s = JSON.parse(readFileSync("/etc/uhuru/settings.json", "utf8"));
const basic = Buffer.from(s.admin_username + ":" + s.admin_password).toString("base64");
writeFileSync(process.argv[1],
  "url = \"https://control.uhuru.pro/admin/plan\"\n" +
  "header = \"Authorization: Basic " + basic + "\"\n",
  { mode: 0o600 });
' "$uhuru_check_dir/request.curl"

curl --disable --config "$uhuru_check_dir/request.curl" \
  --resolve control.uhuru.pro:443:127.0.0.1 \
  --silent --show-error --fail --connect-timeout 5 --max-time 10 \
  --output /dev/null --write-out 'HTTP %{http_code}\n'
systemctl is-enabled certbot.timer
systemctl is-active certbot.timer
SH
```

Фактический итог:

```text
HTTP 200
enabled
active
```

Не используйте `curl -v`, trace или пароль/Authorization/секретную ссылку в аргументах команд. Для других административных операций используйте защищённые request/result-файлы по [README](../README.md#administrative-http-interface).

## Команды для уже работающего VPS

Проверить состояние без повторной установки:

```sh
systemctl is-enabled uhuru-control-plane.service
systemctl is-active uhuru-control-plane.service
sudo systemctl status --no-pager --full uhuru-control-plane.service
systemctl is-enabled certbot.timer
systemctl is-active certbot.timer
pg_lsclusters
sudo nginx -t
sudo ss -ltnp | grep -E ':(80|443|8080|5432)\b'
```

Перезапуск приложения при необходимости:

```sh
sudo systemctl restart uhuru-control-plane.service
sudo systemctl status --no-pager --full uhuru-control-plane.service
```

После изменения nginx сначала проверка, затем reload:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

На существующем VPS не повторяйте `createdb`, `schema.sql`, `app-role.sql`, генерацию deploy key или создание настроек. Обновление кода, миграция схемы и восстановление данных требуют отдельной процедуры; этот документ описывает первоначальную установку и её проверки.

## Что осталось за пределами выполненного деплоя

- Исправление уязвимости `fast-uri` отложено по решению администратора.
- VPN-нода ещё не зарегистрирована и не настроена в рамках этой инструкции. Для её Agent публичный адрес Control Plane — `https://control.uhuru.pro`.
- Бэкап не создавали, восстановление не проверяли. Автоматические бэкапы и снимки отключены; требования к разрешённым зашифрованным копиям — в README.
- Успех проверок подтверждает работу Control Plane, PostgreSQL, nginx и HTTPS. Проверка всего VPN-пути и клиентского подключения относится к следующему этапу.
