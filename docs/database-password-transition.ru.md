# Переход существующего VPS с peer на пароль БД

Новый сервер требует объект `database` с полями `host`, `port`, `user`, `password`, `database`, `maxPoolSize`.
`maxPoolSize` — положительное целое число соединений в пуле; в примере используется `10`.
Автодеплой не обновляет `/etc/uhuru/settings.json`, PostgreSQL или systemd unit.
Подготовьте их до выкладки кода, сохранив возможность отката.
Не запускайте повторно `schema.sql` и `deploy/app-role.sql`: схема и права роли не меняются.

1. Сохраните защищённую копию текущего `/etc/uhuru/settings.json`.
2. Установите новый `deploy/postgresql-secrets.conf` в включаемый каталог конфигурации
   выделенного PostgreSQL-кластера. Он сохраняет ограничения журналов, включает
   `password_encryption = 'scram-sha-256'` и listener только на `127.0.0.1`.
3. В начало `pg_hba.conf` добавьте `host uhuru uhuru 127.0.0.1/32 scram-sha-256`.
   Сохраните существующие локальные peer-правила: они нужны администрированию и старой версии приложения.
   Перезапустите кластер. На записанном VPS это `systemctl restart postgresql@16-main`.
4. Задайте отдельный случайный пароль БД интерактивно:

    ```sh
    sudo -u postgres psql -X -d postgres -c '\password uhuru'
    ```

5. В `/etc/uhuru/settings.json` добавьте `database` из нового примера с этим паролем.
   На период отката оставьте также старое `database_socket`: старая версия читает его,
   новая — объект `database`. Сохраните `640 root:uhuru`; пароль не передавайте в аргументах команд и не выводите.
6. Из проверенного checkout установите проверку среды и новый unit:

    ```sh
    sudo install -m 0755 deploy/check-runtime.sh /usr/local/sbin/uhuru-check-runtime
    sudo install -m 0644 deploy/uhuru-control-plane.service /etc/systemd/system/
    sudo systemctl daemon-reload
    ```

    Проверка расположена вне каталогов версий, поэтому остаётся доступной при откате.
    Требования к `LimitCORE=0` и `core_pattern` из README сохраняются.

7. Проверьте новый пароль через `psql -X -h 127.0.0.1 -U uhuru -d uhuru -W -c 'SELECT current_user'`.
   Он должен подключиться как `uhuru`; неверный пароль должен быть отклонён.
   `ss -ltnp` должен показывать PostgreSQL только на `127.0.0.1:5432`.
8. Выложите проверенный commit обычным механизмом деплоя. Из-за изменения комментария
   в `deploy/app-role.sql` сработает существующий SQL gate. После проверки, что SQL-команды
   и права роли не изменились, используйте ручной `uhuru-deploy deploy CHECKED_MAIN_SHA --schema-reviewed`
   по [инструкции автодеплоя](autodeploy.ru.md). Проверьте административный HTTPS API.

До окончания периода отката сохраняйте `database_socket` и локальную peer-аутентификацию.
Возврат через SQL gate требует `uhuru-deploy rollback --schema-reviewed` после проверки совместимости.
После окончания периода отката удалите `database_socket` из действующих настроек.
TCP PostgreSQL остаётся закрытым извне; данные и таблицы при переходе не меняются.
