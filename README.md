# Gonka Forward Tools

Инструменты хоста и покупателя для сделок Gonka Forward. Подготовка и проверка
работают без кошелька. Владелец выбирает способ подписания; tools проверяет
полученную транзакцию перед отдельной отправкой.

**v0.2.0: общий TypeScript SDK, CLI и адаптер Keplr.** Фронтенд и keeper используют
одно ядро подготовки, проверки, отправки и подтверждения; способы подписи различаются.
См. [руководство SDK](docs/sdk.md). Rust API и расписание keeper в эту версию не входят.
Keplr проверяется синтетическими тестами; совместимость реального расширения с Gonka
ещё не подтверждена. Результаты конкретных проверок и
ограничения опубликованы в [validation](docs/validation.md). Кошелёк не считается
совместимым только потому, что умеет показывать GNK.

## Установка в отдельном каталоге

Нужны Git и Node.js **24.13.0** (24 LTS). Linux/macOS или Windows/WSL:

```sh
git clone https://github.com/gonka24/forward-tools.git
cd forward-tools
npm ci --ignore-scripts
npm test
npm run build
node dist/src/cli.js help
node dist/src/cli.js doctor
node dist/src/cli.js deployment verify
```

В PowerShell команды те же; при ограничении исполнения `npm.ps1` используйте
`npm.cmd`. Результаты — JSON, ошибки содержат стабильный `code`. Exit 0 означает
завершённую проверку; 1 — ошибка или неполнота; 2 — ошибка использования.
Храните свои файлы в `.forward/`, который исключён из Git.

Версия 0.2.0 пока подготовлена локально и не опубликована. Для передачи SDK из этого
checkout выполните `npm pack` после тестов и установите полученный `.tgz` в приложение.
Публичный `main`/старый релиз не следует считать этой версией до её публикации.

Текущее развёртывание `mainnet-v1`: Factory
`gonka1ea2s57dvs06fr5mjzmna9w9vt0xylrna5cjtmzr5h72vkrza3xxsp7eayy`, code 120,
Deal code 119. Factory не имеет Wasm admin; её закреплённый код создаёт Deal
без admin, что tools проверяет у каждого экземпляра. Адрес USDT и контрольные суммы закреплены
в реестре. USDT здесь — CW20 внутри Gonka, полученный через Ethereum bridge.
GNK нужен отдельно для комиссии сети.

## Я хост

Кто подписывает каждую операцию и когда она доступна — в [таблице жизненного цикла](docs/lifecycle.md).

Передайте своему агенту [готовый промпт](docs/host-agent-prompt.md). Для проверки
нужен публичный **participant-адрес**, а для routing — возможность подписи
его владельцем (cold key). Working/warm key ноды не имеет права перенаправлять
награды. v1 поддерживает прямую подпись владельца; authz-обёртки не реализованы.

```sh
node dist/src/cli.js host check --host HOST_ADDRESS --signer OWNER_ADDRESS
node dist/src/cli.js report readiness --host HOST_ADDRESS --signer OWNER_ADDRESS --out .forward/readiness.local.json
```

`readiness` намеренно сообщает неполноту, пока условия и способ подписания не
подтверждены. Согласуйте цену **USDT за целый GNK**, бюджет **USDT** и будущую
эпоху `E` в пределах 40 от текущей. Цена включает удерживаемую из gross USDT
комиссию 1,5%; Host net = gross − fee. Остаток бюджета возвращается Buyer.

Отчёт можно дополнить `--price`, `--budget`, `--epoch` и
`--signing-proofs FILE1,FILE2,FILE3`: проверенными подписанными envelope для
contract execute, routing и native claim. Проверка подписей подтверждает
возможность подписания этих форматов; сама по себе ничего не отправляет.
Полную готовность всех форматов можно подтвердить по мере прохождения сделки;
неполный общий отчёт не запрещает отдельно проверенную доступную операцию.

```sh
node dist/src/cli.js deal prepare --action create-offer --sender HOST_ADDRESS --epoch E --price AGREED_PRICE --budget AGREED_BUDGET --out .forward/offer.local.json
```

Проведите операцию по процедуре ниже и получите адрес Deal из подтверждённого
результата. Затем **до E** настройте награды для этой эпохи:

```sh
node dist/src/cli.js deal prepare --action route --sender HOST_ADDRESS --deal DEAL_ADDRESS --out .forward/route.local.json
```

Tools меняет только `(Host, E)`, не отправляет старые назначения других эпох.
Routing готовится только для Deal в состоянии Open или Funded: у отменённого Deal
нет пути выпуска GNK, и направленные туда награды были бы заблокированы навсегда.
`remove-route` доступен в любом состоянии, чтобы исправить ошибочное назначение.
После подтверждения routing покупатель может финансировать Deal. В начале E
выполните `lock`. В E+1 проверьте claim: сеть могла выполнить его автоматически.
Если ещё не выполнен, подготовьте `claim` с **публичным ранее зафиксированным
claim seed**, который использует ваша Gonka-нода. Это число, не seed-фраза
кошелька; tools его не генерирует. Native eligibility окончательно проверяет сеть
при исполнении. В закреплённой версии Gonka есть дефект симуляции claim: см. ниже.

```sh
node dist/src/cli.js deal prepare --action lock --sender CALLER_ADDRESS --deal DEAL_ADDRESS --out .forward/lock.local.json
node dist/src/cli.js deal prepare --action claim --sender HOST_ADDRESS --deal DEAL_ADDRESS --seed COMMITTED_INTEGER --out .forward/claim.local.json
node dist/src/cli.js deal prepare --action settle --sender CALLER_ADDRESS --deal DEAL_ADDRESS --out .forward/settle.local.json
node dist/src/cli.js deal prepare --action withdraw --sender CALLER_ADDRESS --deal DEAL_ADDRESS --role host --out .forward/host-payment.local.json
```

Каждую операцию подтверждайте отдельно. Для `fee` и `buyer` используются отдельные
withdraw-транзакции; ошибка одной выплаты не должна отменять остальные.

## Я покупатель

Нужны Gonka-адрес, точный бюджет в настроенном CW20 USDT и GNK на gas.
Ethereum USDT или токен с таким же названием в другой сети не финансирует Deal.
Bridge выполняется отдельно; эта версия tools не управляет им.

```sh
node dist/src/cli.js deal status --deal DEAL_ADDRESS
node dist/src/cli.js deal prepare --action fund --sender BUYER_ADDRESS --deal DEAL_ADDRESS --out .forward/fund.local.json
```

Перед подписью сравните Host, E, цену, бюджет, Factory и токен с согласованными
условиями. Подготовка проверяет происхождение Deal, отсутствие admin и routing.
Финансирование — CW20 **Send с Fund hook** на точную сумму до E. Обычный Transfer
не финансирует сделку и может оставить средства без механизма возврата.

После расчёта получите pending Buyer USDT через `withdraw --role buyer`.
Для доступных GNK используйте `release`; vesting может продолжаться после
`completed`, поэтому повторяйте status и выпускайте новые разблокированные GNK.

## Подготовка → подпись → отправка → подтверждение

Для каждой операции:

```sh
node dist/src/cli.js tx export --operation .forward/offer.local.json --out .forward/unsigned.local.json
```

Экспорт повторяет live-проверки и симуляцию, фиксирует account/sequence,
gas с запасом 30%, комиссию 1 ngonka/gas. По умолчанию предел 10 000 000 ngonka;
увеличение требует явного `--max-fee`. Для аккаунта без on-chain pubkey укажите
**публичный** compressed secp256k1 key в `--public-key BASE64`.

Для native claim закреплённый Gonka commit может паниковать при симуляции:
`getMustBeValidatedInferences` использует отсутствующий `HeaderInfo.Hash`.
По умолчанию tools блокирует экспорт. Только для этой конкретной ошибки можно
явно указать `tx export ... --claim-gas REVIEWED_LIMIT`. Владелец выбирает лимит,
а не tools; лимит равен максимально списываемой комиссии в ngonka при текущей
цене gas и остаётся ограничен `--max-fee`. Пакет содержит `gasReview` с причиной
и предупреждением. Это не успешная симуляция и не доказательство native
eligibility: неуспешная включённая транзакция может списать gas.
Ошибка RPC, неверный seed или другая ошибка claim не допускает этот путь.
Подпись и отправка всё равно требуют отдельного подтверждения владельца.

Файл содержит пакет tools и стандартную Cosmos JSON-транзакцию в поле `tx`.
Внешнему инструменту подписи передаётся это поле, не весь envelope tools.
Подпишите SIGN_MODE_DIRECT с указанными chain ID/account number. Адаптер любого
другого кошелька должен уметь кодировать все сообщения операции; инструкция
разработчику — [adapters](docs/adapters.md).

При использовании локального `inferenced`:

```sh
node dist/src/cli.js tx sign --unsigned .forward/unsigned.local.json --adapter inferenced --cli PATH_TO_INFERENCED --key LOCAL_KEY_NAME --home KEYRING_DIRECTORY --backend os --out .forward/signed.local.json
```

Tools покажет операцию, запросит `CONFIRM` для подписи и передаст управление
терминалу inferenced. Пароль вводится там. Приватный ключ остаётся в keyring.
На Windows используйте WSL с Linux inferenced и Linux Node; путь CLI должен
быть исполняемым файлом или executable wrapper, а не строкой shell-команды.

Для внешнего подписанта:

```sh
node dist/src/cli.js tx import --unsigned .forward/unsigned.local.json --signed-tx EXTERNAL_SIGNED_JSON --out .forward/signed.local.json
```

Принимается Cosmos signed JSON либо `{"tx_bytes":"BASE64_TXRAW"}`.
Проверяются подпись, chain/account, отправитель, sequence, сообщения, memo и fee.
Подпись должна быть low-S: Cosmos SDK отклоняет high-S, поэтому tools не считает
её проверенной. Проверенная подпись ещё не означает отправку:

```sh
node dist/src/cli.js tx broadcast --signed .forward/signed.local.json --receipt .forward/submission.local.json --confirm
node dist/src/cli.js tx confirm --receipt .forward/submission.local.json --out .forward/result.local.json
```

Перед отправкой нужны явный флаг и подтверждение владельца в терминале; подпись
проверяется до запроса `CONFIRM`. Receipt записывается **до HTTP-запроса**,
чтобы восстановиться после обрыва. Sync `height=0/code=0` — приём в mempool;
только включение и проверка результата завершают операцию. Индекс транзакций не
требуется: используется ограниченный поиск хэша в блоках. Если узел уже знает
эти байты (повторная отправка после обрыва), receipt остаётся
`SUBMISSION_UNKNOWN`: подтверждайте тот же хэш, не экспортируйте новую транзакцию.

Выходные файлы (`--out`, `--receipt` у broadcast) никогда не перезаписываются:
существующий путь отклоняется до сетевых проверок и подписи.

## Возвраты, отмена и восстановление

- `cancel`: Open без Buyer; до E подписывает Host, E..E+4 может любой caller.
  Exact routing блокирует отмену: до E сначала выполните `remove-route`.
- `refund`: Funded с доказанным отсутствием/несовпадением routing в E..E+4;
  либо Locked с точным `claimed=false` от E+2.
- Ошибка summary не означает отсутствие наград. От E+3 можно явно запросить
  `--emergency`; tools требует ручного решения и успешной симуляции контракта.
  Такой возврат окончателен: при последующем восстановлении GNK принадлежит Host.
- `release`: Releasing/Completed/Refunded/Expired с доступными GNK.
  `forward-excess`: тот же экономический выпуск, только в Completed.
- Если Lock пропущен до E+5, tools сообщает операционный сбой; не обещает возврат,
  которого контракт не допускает.

```sh
node dist/src/cli.js deal prepare --action refund --sender CALLER_ADDRESS --deal DEAL_ADDRESS --out .forward/refund.local.json
node dist/src/cli.js deal prepare --action release --sender CALLER_ADDRESS --deal DEAL_ADDRESS --out .forward/release.local.json
```

После таймаута продолжайте подтверждение **того же хэша** из сохранённого receipt
или результата с `nextHeight`. Не отправляйте повторно автоматически.
Незавершённый результат содержит `nextHeight` и `code`: `CONFIRMATION_TIMEOUT`
или `SCAN_LIMIT` (лимит поиска). При неполных данных блока —
`BLOCK_DATA_UNAVAILABLE`; `nextHeight` остаётся на непроверенном блоке.
Сохраните результат через `--out`, затем
передайте его как следующий receipt, используя новое имя выходного файла:

```sh
node dist/src/cli.js tx confirm --receipt .forward/result.local.json --out .forward/result-next.local.json
```

Результат сохраняет исходный `fromHeight` отправки, а начало этого поиска пишет в
`scanFromHeight`; поля прошлого поиска не переносятся. Если включение найдено, но
постусловие не подтвердилось или его запрос не удался, факт включения всё равно
сохраняется, `postcondition.status` равен `UNVERIFIED` с `code`, а exit code — 1.

Если sequence изменился, сначала выясните судьбу предыдущей транзакции.
Included failure может списать gas, но не означает выполненную операцию.

Условия контрактов и проверки tools зависят от поведения Gonka и USDT.
Отсутствие Wasm admin у Factory/Deal не устраняет управление этими зависимостями.
Ссылки на источники и результаты — [provenance](provenance/README.md).
