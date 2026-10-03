# Первый деплой Control Plane на Debian/Ubuntu VPS

Схема: `Node Agent / VPN-клиент / администратор → HTTPS :443 nginx → HTTP 127.0.0.1:8080 Control Plane → Unix socket PostgreSQL`. Входящий порт для Agent не нужен: он сам отправляет `POST /agent/v1/sync`. Публичны `/agent/v1/sync`, `/s/:secret` и пока `/admin`; последний защищён Basic Auth приложения, без ограничения по IP или VPN.

## Подготовка

1. Направьте DNS A-запись `control.example.com` на VPS. Если есть AAAA-запись, она тоже должна вести на этот VPS. Во всех командах ниже замените `control.example.com` на реальное имя.
2. В firewall провайдера и хоста оставьте снаружи SSH, TCP 80 для ACME и TCP 443. TCP 8080 и PostgreSQL наружу не открывайте.
3. Установите Node.js 24.11+ в линейке 24.x, PostgreSQL 15+, nginx и Certbot. Разместите этот репозиторий в `/opt/uhuru` с владельцем `root`, без права записи для сервисного пользователя.
4. До запуска сервиса выполните требования к PostgreSQL, его журналам, правам на данные/WAL и запрету core dumps из [README](../README.md#install-on-a-dedicated-linux-control-plane). Они остаются обязательными после добавления nginx.

Под `root` создайте сервисного пользователя, базу и настройки:

```sh
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin uhuru
install -d -o root -g uhuru -m 0750 /etc/uhuru
cd /opt/uhuru
npm ci --omit=dev --ignore-scripts
runuser -u postgres -- createdb uhuru
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d uhuru -f schema.sql
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d uhuru -f deploy/app-role.sql
install -o root -g uhuru -m 0640 deploy/settings.example.json /etc/uhuru/settings.json
install -m 0644 deploy/uhuru-control-plane.service /etc/systemd/system/
```

SQL-команды предназначены только для **новой** базы, не для повторного запуска или восстановления. В `/etc/uhuru/settings.json` установите `origin` равным `https://control.example.com` и замените примерный пароль на уникальный случайный пароль из менеджера секретов. Не записывайте его в аргументы команд, историю shell или журналы. `port` оставьте `8080`; приложение принудительно слушает только `127.0.0.1`. Поля `tls_cert`, `tls_key` и `listen_host` для нового развёртывания не нужны: сертификат принадлежит nginx.

## Сертификат и nginx

Ниже — вариант с Certbot HTTP-01. Он выдаёт общедоверенный сертификат и сохраняет webroot для автоматического продления. Сначала включите временный HTTP-сервер для проверки домена:

```sh
apt-get update
apt-get install -y nginx certbot
install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge
cat > /etc/nginx/sites-available/uhuru <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name control.example.com;
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
certbot certonly --webroot -w /var/www/letsencrypt -d control.example.com
```

Теперь установите [конфигурацию nginx](../deploy/uhuru-control-plane.nginx.conf), заменив в ней `control.example.com` на то же имя, что использовалось в Certbot:

```sh
install -m 0644 /opt/uhuru/deploy/uhuru-control-plane.nginx.conf /etc/nginx/sites-available/uhuru
# Отредактируйте /etc/nginx/sites-available/uhuru: server_name и оба пути /etc/letsencrypt/live/...
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl enable --now uhuru-control-plane
```

nginx слушает 80 только для ACME и отдаёт 404 на остальные HTTP-запросы. Публичный API доступен только по HTTPS:443. Конфигурация передаёт исходный URL без переписывания, сохраняет `Authorization`, не кэширует и не буферизует секретные тела. Access log выключен; error log этого виртуального хоста направлен в `/dev/null`, поскольку ошибки upstream могут включать полный URL секретной ссылки. Это сокращает диагностику nginx: перед перезагрузкой проверяйте `nginx -t`, а доступность проверяйте HTTPS-запросом. Не включайте для этого хоста журналы запросов, отладочные дампы, proxy cache или сторонний сборщик HTTP-тел без отдельной проверки секретов.

Включите штатный таймер продления Certbot и перезагрузку nginx после выдачи нового сертификата:

```sh
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-uhuru-nginx <<'SH'
#!/bin/sh
systemctl reload nginx
SH
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-uhuru-nginx
systemctl enable --now certbot.timer
certbot renew --dry-run
```

## Проверка перед регистрацией Ноды

```sh
ss -ltnp | grep -E ':(80|443|8080)\b'
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' https://control.example.com/admin/plan
```

Ожидается nginx на `:80` и `:443`, приложение только на `127.0.0.1:8080`, а неавторизованный `/admin/plan` отвечает `401` через публичный HTTPS. Проверьте с другого хоста, что TCP 8080 и 5432 недоступны. Не проверяйте подписку, вставляя секретный URL прямо в командную строку или включив `curl -v`; порядок защищённых запросов описан в [README](../README.md#administrative-http-interface). После тестовой выдачи и синхронизации проверьте, что закрытый ключ TLS, конфигурации, ссылки подписки и Bearer не попали в журналы/снимки VPS. Для проверки ошибок прокси используйте одноразовые секреты.

В настройках каждой Ноды задайте `control_plane` равным `https://control.example.com`. Для общедоверенного сертификата `ca_file` может быть `null`; Bearer и `node_id` устанавливаются как раньше. nginx не должен перенаправлять `/agent/v1/sync`: Agent считает редирект ошибкой и приостанавливает опрос до исправления и перезапуска. Публичные подписочные ссылки генерируются из `origin`, поэтому в нём не должно быть `:8080`.
