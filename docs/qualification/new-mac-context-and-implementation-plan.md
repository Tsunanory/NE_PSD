# NE_PSD: контекст проекта и план полной реализации на новом Mac

Дата сводки: 2026-11-26. Сводка основана на переданном финальном пакете от 2026-10-16 и сохранённых handoff/evidence. Это не новый прогон тестов и не подтверждение текущей доступности Photoshop, моделей или Windows.

## Graphify как источник контекста

Перед анализом архитектуры прочитать [Graphify repository и документацию](https://github.com/Graphify-Labs/graphify), а также установленный `graphify` skill (`SKILL.md`; на исходном Mac: `/Users/tsunanory/.codex/skills/graphify/SKILL.md`). NE_PSD уже содержит `graphify-out/GRAPH_REPORT.md`; проверить наличие `graphify-out/graph.json` и актуальность графа относительно выбранного transfer snapshot. Если graph JSON есть, использовать предусмотренный skill запрос к графу для вопросов о связях и потоках кода; если граф отсутствует или устарел, обновлять его только по процедуре skill и с учётом проектных правил моделей, worker-routing и владения файлами. Graphify дополняет, но не заменяет утверждённый design, планы и проверяемые handoff/evidence.

## Каноническая основа

- Для переноса на новый Mac предназначен `deliverables/mac-photoshop-2025-test-2026-10-16-final/ne-psd-mac-test.tar.gz`, SHA-256 `0cb50ee1a2406f0abb25b4b5db77a843ffc99ee093af436bfbf043d37e2ef5af`. Его манифест содержит 1 177 файлов; PSD отсутствует. Подписью этот манифест не является.
- Этот пакет прошёл проверку архива, проверку после извлечения и повторную проверку в другом каталоге. Зафиксированы успешные `npm ci`, сборки contracts/Photoshop и schema-only probe на `darwin/arm64` с Node 22.23.2. Это подтверждает переносимость указанной arm64-зависимости, но не живую связь с Photoshop, не Intel Mac и не полную сборку приложения.
- Полная подготовка и живой MCP probe для Photoshop описаны в `mac-test-runbook.md`. Отдельного `MAC-TEST-RESULT.md` в переданном комплекте нет. Исторический PSD `мокап_готово.psd` в пакете отсутствует; его размер и хеш должны быть заново проверены на принимающем компьютере.
- Корневой `master` — ранняя основа. Интегрированный кандидат и наиболее полные handoff находятся в `.worktrees/core`; в исходной машине есть и другие worktree. Их рабочие изменения не являются автоматически чистым релизным снимком. На новом Mac сначала фиксировать один проверенный пакет/коммит как базу и не смешивать его с корневым `master`.
- Имеющиеся в исходном рабочем каталоге изменения и неотслеживаемые файлы не очищать. `config.toml` не менять.

## Назначение и устройство

NE_PSD — локальное настольное приложение: на каждый входной asset формировать ровно три Photoshop mockup-изображения, проверять изображения и доказательства, затем публиковать комплект целиком. Разработка ведётся на macOS; поставка и окончательная квалификация — Windows 11 x64.

| Часть | Ответственность | Состояние по последним handoff |
|---|---|---|
| `packages/contracts` | Строгие версии схем, Zod/JSON Schema, доказательства операций и путей | Основа и тесты есть; изменения общего контракта согласует только A |
| `packages/core` | Очередь, SQLite, попытки, изоляция источников, recovery, QA, review, атомарная публикация | Значительная реализация и fake-тесты; последняя интеграция и сквозные V2 proofs требуют завершения/повторной проверки |
| `packages/photoshop` | Один MCP-контроллер и lock, инвентаризация PSD/PSB и links, копии, рендер, recovery | V2 адаптер и production composition есть; настоящий scanner/операции Photoshop и семантические proofs не квалифицированы |
| `packages/intelligence` | Настройка модели, planner, диагностика, строгий review и измерение capacity | Реализованы локальные интерфейсы и испытания на искусственных данных; точный Qwen artifact/runtime и vision reviewer не квалифицированы |
| `apps/desktop` | Electron/React UI, IPC, настройка, job state, безопасное завершение и evidence | Fake-backed интерфейс и локальные тесты есть; реальная production composition и packaged runtime integration открыты |

Реализация опирается на frozen design `docs/superpowers/specs/2026-09-21-ne-psd-design.md`, план разбиения — `docs/superpowers/plans/2026-09-21-ne-psd/`, правила владения — `docs/superpowers/parallel-build.md`. Один runtime job даёт ровно варианты 1/2/3; fit modes — `cover`, `contain`, `stretch`; исходный PSD, входы и linked assets остаются неизменными. Для каждого asset используется отдельная рабочая копия и полная связанная closure.

Photoshop управляется одним выбранным контроллером. Имена слоёв, capability schema и успешный ping не доказывают геометрию, clipping, visibility, link isolation или качество экспорта. Нужны проверяемые route/selector, копии, sentinel, измеренные bounds, V2 proofs, хеши и decoded outputs. Не использовать произвольный JSX/UXP, второй контроллер или неподтверждённую замену backend.

Модели не взаимозаменяемы: целевой локальный `Qwen3.8-27B` требует точного artifact/runtime/chat-template и qualification; Q4/Q6/Q8 проходят одинаковые функции и проверки. Планировщик и независимый vision reviewer — отдельные способности. Для реального Windows job reviewer должен открыть каждый из трёх результатов в свежей сессии с отдельным prompt и фактическими изображениями. Текстовая модель не может подтвердить внешний вид. Автоматического fallback нет.

## Подтверждённое и неподтверждённое

- Интегрированный локальный handoff фиксирует 897 тестов по шести наборам (integration 14, contracts 60, core 153, intelligence 237, desktop 184, Photoshop 249), workspace checks, сборки и `git diff --check`. Это историческое локальное evidence, не новый прогон на новом Mac.
- В том handoff Electron E2E не запустились: 10 случаев завершились `Process failed launch`; они не входят в 897. Отдельный handoff Desktop для другой фиксированной версии сообщает 10 GUI E2E passed. Не переносить его результат на интегрированный core snapshot.
- Подтверждены fake/injected boundaries и локальные тесты. Они не доказывают реальный Photoshop, Windows, точную модель, установщик, работу без сети или качество настоящих изображений.
- Release gates остаются открытыми: связка реального B adapter/scanner и Core V2; Photoshop 2025 + исходный PSD + links; все три fit/export-пути и три decoded результата; Qwen artifact/runtime/vision review; Windows 11 x64 installer/offline/recovery; 100 реальных assets (300 файлов и 100 свежих review-сессий); подпись выпуска.
- Успешный переносный schema-only probe дал 125 обнаруженных MCP tools и 0 обращений к Photoshop. Это инвентаризация схемы, не live qualification.

## План работ на новом Mac

### 1. Зафиксировать и проверить перенос

1. Распаковать только финальный архив в отдельную папку. Проверить `SHA256SUMS.txt`, затем выполнить `node scripts/package-mac-test.mjs verify --package-root <absolute>/ne-psd-mac-test` до `npm ci`, сборки и любых изменений.
2. Сохранить вывод, SHA-256 архива, snapshot ID и полный путь к `project/`. Не продолжать с изменённым/неверифицированным снимком.
3. Зафиксировать архитектуру Mac. Для arm64 использовать только arm64 runtime/native modules; Intel требует отдельной установки и отдельного evidence. Проверить Node `22.23.2`, npm `10.9.8`, ABI `127`; локальный Node хранить рядом с проектом, не менять global config.
4. Выполнить зафиксированный в runbook `npm ci` в `project/`, с отдельным writable cache вне чистого снимка и временным Git HTTPS rewrite только на время процесса. Сохранить версии и логи. Сеть может понадобиться.

### 1a. Прочитать Graphify-контекст

1. Прочитать Graphify skill и официальный репозиторий по ссылке выше; применить его fast path к `graphify-out/graph.json`, если файл входит в проверенный snapshot.
2. Запросить графом связи Contracts, Core, Photoshop, Intelligence и Desktop, а также точки сборки production composition и publication. Сверить каждый вывод с исходниками и handoff-документами; граф — навигация, не доказательство.
3. Если `graph.json` отсутствует или устарел, обновить граф после выбора канонического snapshot согласно Graphify skill. Не запускать повторное полное извлечение автоматически, если skill разрешает инкрементальное обновление.

### 2. Получить честную исходную линию

1. До правок выполнить `npm run check`, `npm run build`, затем `npm run test:contracts`, `test:core`, `test:photoshop`, `test:intelligence`, `test:desktop`, `test:integration` и `test:e2e:desktop`. Сохранять exit code и сырые логи по каждому запуску.
2. Повторить неуспешные тесты после причины, отделив setup/host failure от кода. Не суммировать результаты разных commits/worktrees и не считать старые отчёты новым Mac evidence.
3. Базовый критерий для дальнейшей интеграции: все доступные unit/integration, checks, typechecks и builds зелёные; E2E либо проходит, либо имеет документированный локальный launcher blocker без ложного pass.

### 3. Завершить интеграцию приложения

1. Открыть план A и recovery authority. Возобновить только неполные bounded tasks из выбранного snapshot. Перед кодом вызвать `ponytail (full)`; выполнение — в отдельных существующих/новых worktree согласно `parallel-build.md`.
2. A владеет `contracts`, Core V2 boundary, SQLite attempt/publication state, общими файлами, root manifests/lockfile и integration suite. Общие контракты и lockfile менять только одним согласованным потоком; B держит единственный Photoshop installation lock. Не выполнять параллельную мутацию Photoshop.
3. Соединить `prepareOwnedInput → render → recover` с durable Core operation identity, полным source/link closure, owned-copy proof, template proof, owner/journal snapshot и положительным release proof. Не replay-ить неоднозначную V1/V2 mutation; неоднозначность удерживает lock до reconciliation.
4. Интегрировать D только через typed production composition: реальные JobService/SetupService, квалифицированный model catalog/evidence, настоящие previews, evidence adapters и launch/shutdown standalone Node/MCP. Упаковка должна fail closed при недостающей квалификации; fake доступен только в явном dev режиме.
5. Закрыть зависимости и полные сквозные тесты: restart/reconcile; pending review и sealed evidence; три варианта; stale/tampered/forged evidence; atomic publication; failure до/после rename; cancellation/pause/close; retry; lost MCP reply; lock contention/release; safe cleanup; diagnostic redaction.

### 4. Квалифицировать Photoshop на новом Mac

1. Сначала выполнить read-only probe по `mac-test-runbook.md`: реально открытый Photoshop 2025 (26.x), его app/executable/version/hash/PID, Node/MCP версии и schema digest. Сохранить исходный probe JSON, stderr, exit code и lock cleanup.
2. До и после проверить открытые пользователем документы и активную вкладку. Источник PSD и каждый linked asset только читать/хешировать; любые изменения — лишь в job-owned copies.
3. Найти настоящий PSD. Если исторический файл найден, сверить размер и SHA-256 из design; другой PSD регистрировать как другой образец. Если отсутствует, live connection проверить можно, template qualification — нельзя.
4. На копиях проверить связанный PSD/PSB closure и scanner, ID-safe selectors, save/reopen, sentinel propagation, clipping/masks, effective bounds, parent/variant visibility, `cover/contain/stretch` и JPEG/PNG: размеры, color profile, alpha/background, quality mapping. Каждый экспорт декодировать и связать digest с операцией и evidence.
5. Успех ping/schema/одного render не закрывает остальные capabilities. Не создавать самостоятельную автоматизацию при недостающей операции: записать точный capability blocker и квалифицировать одобренный backend отдельно.

### 5. Квалифицировать локальную модель и review

1. Принять только точный `Qwen3.8-27B` artifact, runtime, tokenizer/chat template и profile с хешами. Проверить JSON-schema, tools, image input и capacity как независимые характеристики.
2. Выполнить фиксированный corpus и ресурсные измерения для каждой выбранной quantization. Q4/Q6/Q8 получают одинаковый corpus и критерии. Без подлинных artifact/runtime/resource evidence модель остаётся недоступной для production.
3. Отдельно квалифицировать vision reviewer и fresh-session protocol с distinct prompt. Тестировать pass/revise/blocked/unknown, три отдельных variant verdicts, stale hashes, невозможность approve при неизвестном результате и публикацию только полного прошедшего набора.

### 6. Проверить desktop и локальную поставку

1. Проверить production startup/shutdown, установки служб, конфигурацию roots, IPC trust boundary, evidence previews, recent-job recovery, pause/cancel/retry и безопасное закрытие.
2. Прогнать GUI и endurance на 10 000 синтетических строк только как тест отзывчивости списка/памяти, не как Photoshop throughput.
3. Собрать macOS dev build для диагностики интерфейса, если нужно; он не заменяет продуктовую цель Windows и не закрывает Windows installer gate.

### 7. Отдельная Windows 11 x64 приёмка

1. На Windows проверить точные Windows Node/MCP/native ABI, vendor files, лицензии и хеши; clean install standard user; installer/upgrade/uninstall; offline run; Unicode/space/long paths; permissions, collisions, pause/recovery; реальные Photoshop links и модель co-residency.
2. На квалифицированном PSD и выбранной модели провести 100 реальных assets: ровно 300 committed exports, 100 свежих reviewer sessions, 300 variant verdicts, unchanged source/link hashes, performance/RAM/VRAM/disk и restart evidence.
3. Проверить Authenticode для installer и установленного EXE. Без ключа выпуск маркируется unsigned internal, а signing gate остаётся открытым.
4. Только после всех требуемых gate evidence фиксировать интегрированный commit, dependency manifest, installer digest, qualification records и release decision. Отсутствующий live host/artifact остаётся `BLOCKED`, не заменяется fake или другим model.

## Модельные и проектные ограничения

- Для реализации и debugging по проектному `AGENTS.md` использовать только явно назначенные `gpt-5.6-luna` worker; worker не делегирует рекурсивно. Координатор не подменяет модель незаметно. Перед coding/review соблюдать локальный task-observer протокол и фиксировать checkpoints.
- Любые будущие digest/token-heavy scheduled jobs — только с явно pinned `gpt-5.6-luna` в настройке задания и фактическом вызове; при недоступности записать ошибку и отложить. Расписаний в текущем выпуске нет.
- Существующие открытые observation items не были предметом обзора по skill. Их backlog не считать очищенным этим планом.

## Условия завершения

**Имплементация завершена**, когда весь контракт реализован без fake в production composition, все обязательные автоматические проверки и сборки воспроизводимо проходят из чистой установки, доказательства привязаны к неизменяемым байтам, восстановление безопасно, а UI не публикует неизвестный/неполный результат.

**Выпуск квалифицирован** только после отдельного live Photoshop/template/model/reviewer и установленного Windows 11 x64 evidence, включая реальный corpus, source preservation и подпись либо явную маркировку internal unsigned. Локальные Mac-тесты сами по себе этот критерий не закрывают.
