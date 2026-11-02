# Garage Apps: community app store для Umbrel

Содержит приложение **Garage Journal** (`garage-vehicle-tracker`): веб-интерфейс + Node.js API + MySQL 8.

## Установка
1. Создайте репозиторий на GitHub и загрузите в его корень содержимое этой папки
   (`umbrel-app-store.yml` и папку `garage-vehicle-tracker`).
2. В `garage-vehicle-tracker/umbrel-app.yml` замените YOUR_NAME и ссылки на свои.
3. В Umbrel: App Store → меню «⋯» → Community App Stores → вставьте ссылку на репозиторий.
4. Откройте «Garage Apps», установите Garage Journal.

Первый запуск занимает 1-2 минуты: скачиваются образы, MySQL создаёт базу, Node ставит драйвер mysql2.

## Данные
Все данные лежат в MySQL (база `garage`): vehicles, parts, part_history, mileage_log, meta.
Файлы базы: `~/umbrel/app-data/garage-vehicle-tracker/data/mysql`.
