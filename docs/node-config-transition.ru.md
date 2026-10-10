# Переход Control Plane на node-config

Новая версия загружает `config/default.json` и защищённый `/etc/uhuru/local.json`.
Старые имена полей сохранены; полный прежний `settings.json` подходит как local override.
Схема и данные PostgreSQL при этом не меняются.
Автодеплой не обновляет секреты и systemd unit: подготовьте их до первого деплоя этой версии.

1. Сохраните прежний unit для отката и скопируйте настройки, не выводя их:

    ```sh
    sudo install -o root -g root -m 0600 /etc/systemd/system/uhuru-control-plane.service /etc/uhuru/previous.service
    sudo install -o root -g uhuru -m 0640 /etc/uhuru/settings.json /etc/uhuru/local.json
    ```

2. Из проверенного checkout установите новый unit. На период совместимости
   оставьте старый аргумент запуска через временный drop-in: новая версия его игнорирует,
   старая продолжает читать прежний файл при автоматическом откате.

    ```sh
    sudo install -m 0644 deploy/uhuru-control-plane.service /etc/systemd/system/
    sudo install -d -m 0755 /etc/systemd/system/uhuru-control-plane.service.d
    sudo tee /etc/systemd/system/uhuru-control-plane.service.d/config-transition.conf >/dev/null <<'UNIT'
    [Service]
    ExecStart=
    ExecStart=/usr/local/bin/node /opt/uhuru/src/server.ts /etc/uhuru/settings.json
    UNIT
    sudo systemctl daemon-reload
    ```

3. Разверните проверенный commit обычным механизмом деплоя. Проверьте запуск и
   административный HTTPS API. Сохраняйте прежний файл и drop-in, пока нужен откат
   к версии без node-config; не меняйте пароли только в одном из двух файлов.
4. После окончания этого периода удалите только `config-transition.conf`, выполните
   `systemctl daemon-reload` и удалите прежний `settings.json`, когда он больше не нужен.
   Остальные drop-in, включая `deploy.conf`, сохраняйте.

При полном возврате к старому формату восстановите `/etc/uhuru/previous.service`
в `/etc/systemd/system/uhuru-control-plane.service`, удалите переходный drop-in,
выполните `systemctl daemon-reload` и перезапустите старую версию приложения.
Для локальной разработки достаточно перенести прежние настройки в `config/local.json`,
установить `chmod 600 config/local.json` и запускать `npm start` без пути в аргументах.
