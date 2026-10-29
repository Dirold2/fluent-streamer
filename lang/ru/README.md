# Fluent Streamer

[English Version](https://github.com/Dirold2/fluent-streamer)

_Fluent_ FFmpeg обёртка для TypeScript-рантаймов, **v0.6.0**
Предоставляет удобный цепочечный (fluent) API для обработки медиа, аудио и видео с помощью FFmpeg.
Поддерживает работу со стримами, кроссфейды, аудиоэффекты, таймауты и отслеживание прогресса.

- **TypeScript-first**: строго типизированный, современный цепочечный API
- **Кросс-рантаймность**: поддержка Node.js, Bun, Deno и Browser (через `@ffmpeg/ffmpeg`)
- **Web Streams**: нативные `ReadableStream`/`WritableStream` с обратной совместимостью со стримами Node.js
- **Обработка аудио**: встроенный эквалайзер (EQ), управление громкостью и динамической компрессией
- **Удобство использования**: оптимальные дефолтные настройки и самодокументируемый API
- **Продвинутые фичи**: кроссфейды, конвертация форматов, управление кодеками, принудительная остановка/таймауты, логирование прогресса

> Работает на базе [FFmpeg](https://ffmpeg.org/).  
> Поддерживается в Node.js, Bun, Deno и браузере. В серверных раннерах потоковая обработка не требует сохранения временных файлов на диск; браузерный раннер буферизует данные в памяти.

---

## Установка

```bash
# Из npm (после публикации)
npm install fluent-streamer

# С GitHub (актуальная версия)
npm install github:dirold2/fluent-streamer

# Использование Yarn
yarn add github:dirold2/fluent-streamer

# Использование PNPM
pnpm install github:dirold2/fluent-streamer

# Использование Bun
bun install github:dirold2/fluent-streamer

```

**Браузер (опционально):** установите WASM-привязки FFmpeg вместе с основным пакетом:

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/core

```

Браузерный раннер выбирается автоматически, если в глобальном контексте определен объект `window`. Он полностью накапливает потоковый вход до закрытия stdin, загружает URL целиком и использует виртуальную файловую систему WASM. Вывод доступен только после завершения `ffmpeg.exec()`: это не live-стриминг и не обработка эффектов во время воспроизведения.

### Миграция с версии 0.4.x

| 0.4.x | 0.5.x |
| --- | --- |
| `import FluentStream from "fluent-streamer"` | `import { FluentStream } from "fluent-streamer"` |
| `const { done } = fs.run()` | `const { done } = await fs.run()` |
| `output: Readable` (Node.js stream) | `output: ReadableStream<Uint8Array>` (Web Stream) |
| `.output(fs.createWriteStream(...))` | `.output("file.wav")` или чтение `output` из `.run()` |

---

## Использование

```ts
import { FluentStream } from "fluent-streamer";

// Простой пример конвертации файла
const fs = new FluentStream()
  .input("input.wav")
  .audioCodec("aac")
  .audioBitrate("192k")
  .output("output.m4a");

const { done } = await fs.run();
await done;
console.log("Конвертация завершена.");

```

---

### Потоковая обработка (Stream Processing)

```ts
import { FluentStream } from "fluent-streamer";
import fs from "node:fs";

// Стримы Node.js принимаются на вход (внутри адаптируются к Web Streams)
const input = fs.createReadStream("track.mp3");

const f = new FluentStream()
  .input(input)
  .format("wav")
  .output("new.wav");

await f.run();
console.log("Поток успешно обработан!");

```

Для перенаправления вывода в пайп используйте `pipe:1` и читайте возвращаемый стрим:

```ts
const { output, done } = await new FluentStream()
  .input(input)
  .format("wav")
  .output("pipe:1")
  .run();

// Направляем Web Stream в целевой поток (Node.js 18+)
import { Writable } from "node:stream";
const file = fs.createWriteStream("new.wav");
await output.pipeTo(Writable.toWeb(file));
await done;

```

---

### Пример офлайн-кроссфейда

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5)    // Кроссфейд длительностью 2.5 секунды
  .output("x.mp3")
  .run();

```

### Live crossfade

Crossfade предварительно буферизует примерно 20 мс (не более 1024 кадров) следующего источника, продолжая выдавать старый без затухания. Отсчёт перехода начинается после готовности буфера или EOF нового источника. Очистка старого декодера выполняется в фоне: завершение перехода означает формирование PCM, а не завершение очистки. Общие `done` и `stop()` ожидают все незавершённые очистки и сообщают об их ошибках. Это убирает ожидание очистки из аудиопути, но не исключает последующие сетевые underrun или паузу после исчерпания старого источника.

`await streamer.crossfade(url, time = 3)` запрашивает немедленный переход к другому файлу/URL в активной смешанной сессии, не дожидаясь конца текущего трека. Длительность задаётся в **секундах** (конечное число `0…3600`); `0` переключает без затухания. Промис завершается после формирования PCM перехода, а не после очистки декодера или окончания нового трека. После `await` можно повторить вызов; параллельные переходы отклоняются. В сессии с включённым режимом доступен и `result.crossfade?.(url, time)`.

Необязательный третий аргумент — `LiveCrossfadeOptions`: `bassHandoff?: boolean` по умолчанию равен `false`. Ручное включение: `await streamer.crossfade(url, seconds, { bassHandoff: true, curve: 'equalPower', headroomDb: 3 })`. Независимые поканальные истории НЧ исходящего и входящего источников позволяют плавно закрывать исходящие НЧ и открывать входящие на участке **35–65%** перехода. Однополюсное разделение (по умолчанию `bassCutoffHz: 180`) пропускает часть сигнала, а не даёт brick-wall срез: остальной спектр продолжает перекрываться, ударные/перкуссия могут конфликтовать. Чистая передача ударных не гарантируется; высота тона и скорость воспроизведения не меняются.

Явно задайте `enableCrossfade: true` в конструкторе или опциях `run()` **до начала воспроизведения**. Между треками сохраняется **тот же `result.output`**, а `result.done` отслеживает завершение/очистку **всей смешанной сессии**, а не отдельных декодеров. Live seek в этом режиме сохраняет тот же публичный результат, output и сессионный `done` (см. раздел Live seek ниже). В отличие от офлайн-фильтра `.crossfadeAudio()` выше, новый источник передаётся во время воспроизведения.

```ts
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  enableCrossfade: true,
  autoDrainOutput: false, // в смешанном режиме auto-drain всегда отключён
  disableThrottling: true, // тактируемый плеер задаёт темп через backpressure
});
const result = await streamer
  .input("first.mp3") // ровно один файл/URL через аргументы FFmpeg
  .audioCodec("pcm_s16le")
  .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
  .output("pipe:1")
  .run();

const player = spawn("ffplay", [
  "-nodisp", "-autoexit", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
], { stdio: ["pipe", "ignore", "inherit"] });
player.on("error", (error) => console.error("Player failed:", error));

// Запустите consumer ДО await перехода; не ожидайте playback здесь.
const playback = result.output.pipeTo(Writable.toWeb(player.stdin));
try {
  // В приложении вызывайте по действию пользователя/таймеру ДО EOF текущего трека.
  await streamer.crossfade("second.mp3", 3);
  await streamer.crossfade("third.mp3", 0); // повтор после await; output тот же
  // Ожидайте конец сессии лишь тогда, когда новые переходы больше не нужны.
  await Promise.all([playback, result.done]);
} finally {
  await result.stop();
  player.kill();
}
```

**Требования и ограничения:**
- Ровно один `.input(fileOrURL)`, представленный `-i` в аргументах FFmpeg, один выход stdout `pipe:1`, без complex-фильтров и дополнительных входов. Входные потоки, pipe и blob не поддерживаются.
- Явно задавайте `pcm_s16le`, `-f s16le`, `-ar 48000` и `-ac 2`, как в примере. При изменении `audioProcessorOptions.sampleRate`/`channels` явно согласуйте `-ar`/`-ac` и формат consumer. Встроенный DSP необязателен; для караоке/EQ и других эффектов включите `useAudioProcessor: true`.
- Consumer должен читать output **до и на протяжении `await crossfade()` и `await seek()`**. Без чтения backpressure останавливает переход и его промис (даже переключению с нулевой длительностью нужен запрос output). Auto-drain в этом режиме отключён. **Не ждите `result.done` перед запросом следующего трека**: к этому моменту сессия уже закончилась.
- Запрашивайте переход самостоятельно до EOF. Это не автоматическая очередь треков, DJ beat matching или планировщик по концу трека. Если один из входов достигает EOF во время перехода, оставшиеся кадры его затухания заполняются тишиной.
- При переходе одновременно работают два декодера FFmpeg: растёт нагрузка CPU и возможен параллельный сетевой трафик. Запуск декодера и прогрев URL могут задержать звук; **gapless-воспроизведение по сети не гарантируется**.
- Browser/WASM runner буферизует вход и выход вместо живого стриминга и не подходит для воспроизведения с live crossfade.

### Подготовленный automix

Готовьте следующий элемент очереди **заранее**, пока consumer из примера live crossfade продолжает читать тот же `result.output`. `prepareAutomix()` — метод `FluentStream`, не результата `run()`; нужны тот же PCM-режим с `enableCrossfade: true` и повторно открываемые файлы/URL.

```ts
import {
  analyzePcm, analyzePcmAsync, analyzeTrack, planAutomix,
  type DjAnalysis, type DjAnalysisOptions, type PcmAnalysisOptions, type AutomixPlan,
  type PrepareAutomixOptions, type PreparedAutomix,
  type AutomixDiagnostic, type AutomixFallbackReason,
} from "fluent-streamer";

// Обработчик очереди приложения: nextUrl и необязательный incomingDurationMs —
// метаданные; currentPositionMs() возвращает текущую позицию в исходном треке.
const preparationAbort = new AbortController();
const prepared = await streamer.prepareAutomix(nextUrl, {
  outgoingRemainingMs: currentDurationMs - currentPositionMs(), // измерить СЕЙЧАС
  incomingDurationMs, // необязательно; если неизвестно, не передавайте
  fallbackSeconds: 8,
  onDiagnostic: (diagnostic: AutomixDiagnostic) => {
    console.log("Решение automix:", diagnostic);
  },
  signal: preparationAbort.signal,
});
// Старый трек звучит во время анализа/буферизации и ожидания start().
if (nextUrl !== queue.nextUrl) {
  await prepared.cancel(); // элемент очереди заменён до старта
} else {
  try {
    await prepared.start(); // ставит PCM-расписание; ждёт завершения overlap
  } catch (error) {
    await prepared.cancel().catch(() => {});
    console.error("Automix не завершён:", error); // проверить очередь и остаток
  }
}
// Если очередь заменена, пока prepareAutomix ещё выполняется, вызовите
// preparationAbort.abort(), обработайте отказ и затем готовьте новый элемент.
```

- `outgoingRemainingMs` — **реальный остаток на момент вызова**, не полная длительность и не задержка таймера. Подготовка вычитает прогресс PCM за время анализа. Consumer должен работать во время подготовки и `start()`; не ждите сначала session `done`.
- Подготовка анализирует оба источника (если не переданы `outgoingAnalysis` / `incomingAnalysis`), выбирает cue и буферизует входящий декодер, не запуская fade. Она резервирует переход: seek, crossfade и вторая подготовка отклоняются во время подготовки/готовности и самого перехода. Вызовите start или cancel своевременно. До старта `cancel()` идемпотентен; после старта отклоняется и не отменяет переход.
- **Автостарта на EOF нет**, подготовка не удерживает EOF открытым. Вызывайте `start()` в активной сессии; `setTimeout` не нужен. Расписание привязано к потреблённым/сгенерированным PCM-кадрам, не к слышимому времени устройства. Поздний старт может сдвинуть квантованное начало на следующий бит. Если overlap уже не помещается с резервом в одну секунду, `start()` отменяет подготовку и отклоняется как устаревший план, а не меняет уже декодированный cue. Обрабатывайте отказ подготовки/старта и заново оценивайте остаток перед повтором.
- Конфигурация декодера и эффекты фиксируются при подготовке. Последующие setters меняют только активный декодер, пока подготовленный трек не станет активным. Кэшированный анализ должен описывать источник **от исходного начала**, не фрагмент после seek. `plan.startMs`, `cueMs`, `dropMs` — абсолютные миллисекунды исходного трека; сессия переводит seek-origin в кадры микшера. `plan.seconds` — секунды. Seek после перехода остаётся абсолютным внутри входящего трека.

**Анализ и планирование.** Во время воспроизведения используйте `await analyzePcmAsync(pcm: Int16Array, sampleRate, options?: PcmAnalysisOptions)`. Общий CPU-анализатор работает в отдельном worker; анализируемый фрагмент копируется, исходный буфер вызывающего кода не передаётся и не отсоединяется. `PcmAnalysisOptions` содержит `signal?: AbortSignal` и `timeout?: number`: дедлайн по умолчанию 25 000 мс включает запуск worker и всю его задачу. Timeout должен быть конечным и положительным. Abort/timeout отклоняет promise и завершает worker; при обычном завершении worker также останавливается до завершения promise. `analyzePcm(pcm, sampleRate)` остаётся явно синхронным API для осознанного офлайн-анализа: блокирует вызывающий/главный поток и не является безопасной заменой во время playback. Оба API требуют конечную положительную частоту дискретизации.

`await analyzeTrack(fileOrURL, { ffmpegPath?, headers?, timeout?, signal? })` декодирует через выбранный для runtime `Processor`/runner, затем автоматически запускает CPU-анализ в worker. `prepareAutomix()` автоматически использует этот путь для каждого источника без готового анализа; отдельно включать worker не нужно. Ошибки запуска/работы worker отклоняют promise: **синхронного fallback нет**. Нужен доступный FFmpeg (либо FFmpeg backend runner). Анализ использует defaults своего runner, а не все playback/run options, и не применяет эффекты воспроизведения. **Общий дедлайн 25 секунд** по умолчанию включает запуск декодера, декодирование, запуск worker и анализ, а не даёт каждой фазе отдельные 25 секунд. Abort/timeout останавливает декодирование и активный worker анализа. Лимит декодированного PCM — 720 000 байт: 90 секунд mono s16le, 4 кГц. Это не ограничение размера сетевой загрузки.

**Развёртывание worker.** Node использует `node:worker_threads`; скомпилированный пакет разрешает отдельный entry `dist/Audio/analysis/DjAnalysisWorker.js` и его зависимость `DjAnalysisCore.js`. Bundler/deployment должен сохранить эти worker/core assets и относительные URL рядом со скомпилированным клиентом либо явно обеспечить эквивалентное разрешение worker assets; одного bundle главного entry недостаточно. Прямой запуск TypeScript-исходников требует **Node ≥22.18**; для более старого Node используйте скомпилированную сборку с учётом обычных требований пакета. Ветка для других runtime использует module Web Worker, но выполнение в Bun, Deno и браузере/Web Worker остаётся **непроверенным**, это не обещание совместимости. Отсутствие Worker или его assets приводит к отказу, а не к анализу в главном потоке.

Все точки входа анализа рассматривают не более **первых 90 секунд**, отказываясь от оценки при длительности меньше **8 секунд** или ненадёжном материале. `DjAnalysis` содержит nullable `bpm`, `beatPhaseMs`, `dropMs`, соответствующие `bpmConfidence`, `beatPhaseConfidence`, `dropConfidence` (эвристики 0–1, не калиброванные вероятности) и `analyzedDurationMs`. Спектральные атаки дают темп/фазу, устойчивый рост энергии — кандидат drop. Неоднозначность половинного/двойного темпа, слабые атаки и переменный темп намеренно снижают confidence или дают null: fallback ожидаем, обходить его не нужно.

Чистая функция `planAutomix({ outgoingAnalysis, incomingAnalysis, outgoingPositionMs, outgoingRemainingMs, incomingDurationMs?, fallbackSeconds, explicitDropMs?, onDiagnostic? })` возвращает `AutomixPlan | null`: поля `seconds`, `cueMs`, `dropMs`, `reason` (`energy-entry`, `tempo-phrase`, `crossfade`), `startMs`, `beatPeriodMs` (null для fallback).

- Для **обоих** треков нужны валидные сетки 70–180 BPM, **BPM и phase confidence ≥ 0.65**, отношение быстрого темпа к медленному ≤ 1.03 (не более 3%). Автоматическому drop входящего трека дополнительно нужны confidence ≥ 0.7 и позиция внутри окна анализа. `explicitDropMs` заменяет детекцию drop только после прохождения проверок обеих сеток/темпов.
- Низкая уверенность или несовместимые темпы дают обычный crossfade с входящего **cue 0**, **без перехода к drop, даже если он указан явно**, с настроенной длиной fallback в пределах ограничений длительности. В `prepareAutomix` fallback по умолчанию 8 секунд; неверная длина fallback в planner тоже заменяется на 8. Такой fallback всё ещё может накладывать перкуссию и не делает микс автоматически идеальным. Неверные исходящие времена/известная длительность входящего трека дают null. Любой overlap ограничен 16 секундами, резервирует секунду исходящего трека и занимает не больше четверти известной длительности входящего.
- Квантованный план использует до 16 битов, предпочитая такты по четыре бита. При надёжных, но неравных BPM в пределах допустимого отношения planner ограничивает расчётный дрейф **1/16 более короткого бита**, сокращая overlap и переходя к целым битам, если такт не помещается. Если overlap по сетке не помещается вовсе, для этих неравных темпов используется короткий обычный **crossfade с cue 0 не длиннее 1 секунды**, а не более длинный настроенный fallback. При равных темпах сохраняются группы по четыре бита и настроенный fallback, если они не помещаются. Четыре бита лишь условно считаются тактом: это **не определение тактовой сильной доли, не изменение высоты/скорости, не time stretching и не гарантия постоянной beat sync**. Бюджет дрейфа предполагает стабильный темп, а не измеряет ошибку фазы; темп может дрейфовать, особенно за пределами анализируемого окна. Подводка к drop приблизительна и не гарантирует его попадания в конец fade.
- `prepareAutomix()` автоматически включает `bassHandoff: true` вместе с плавным ослаблением баса исходящего трека до **−12 dB**, overlap `equalPower` и **3 dB** headroom в середине. Независимые истории НЧ исходящего и входящего источников обеспечивают плавную передачу на участке **35–65%**: исходящие НЧ закрываются, входящие открываются. Это однополюсное разделение с утечкой сигнала, не brick-wall изоляция и не полный обмен частотными диапазонами. Широкополосные огибающие по-прежнему перекрываются, поэтому ударные/перкуссия могут накладываться; чистое разделение ударных и автоматически идеальный микс не гарантируются. Высота тона и скорость воспроизведения не меняются, time stretching не применяется.

**Диагностика решения automix.** `PrepareAutomixOptions.onDiagnostic?: (diagnostic: AutomixDiagnostic) => void` получает решение planner независимо от `verbose`. Callback вызывается ровно один раз, когда выполняется планирование, даже если planner возвращает `null` (тогда `prepareAutomix()` отклоняет promise); ошибки или отмена до планирования не создают диагностику решения. Исключения callback подавляются и не меняют план и не прерывают подготовку. Прямой вызов `planAutomix()` тоже принимает `onDiagnostic` с тем же правилом одного вызова на решение, включая результат null. `AutomixDiagnostic` и `AutomixFallbackReason` — экспортируемые публичные типы.

- `outgoing` и `incoming` содержат скалярные снимки анализа **обоих треков**: `bpm`, `bpmConfidence`, `beatPhaseMs`, `beatPhaseConfidence`, `dropMs`, `dropConfidence`, `analyzedDurationMs`. Отсутствующие и неконечные числа заменяются на `null`; URL источников не включаются. `outgoingGridIssues` / `incomingGridIssues` объясняют ошибки проверки сеток. `timing` содержит `outgoingPositionMs`, `outgoingRemainingMs`, `incomingDurationMs`, `fallbackSeconds`, `explicitDropMs`, также приведённые к конечным числам или `null`.
- `fallbackReason: AutomixFallbackReason | null` принимает `unreliable-both-grids`, `unreliable-outgoing-grid`, `unreliable-incoming-grid`, `tempo-mismatch`, `insufficient-overlap`, `insufficient-grid-window`, `incoming-duration-limit` или `invalid-timing`; если причин fallback/отказа нет, значение `null`. `outcome` — причина полученного плана (`energy-entry`, `tempo-phrase` или `crossfade`), либо `null`, если план невозможен.
- `tempoRatio` — отношение быстрого положительного конечного BPM к медленному (либо `null`), даже при ненадёжных сетках. `octaveRelated` отмечает отношение от 1.85 до 2.15: это **только диагностика**, не коррекция темпа, не разрешение обходить пороги confidence и не автоматический seek к drop.
- При `verbose: true` настроенный logger также получает `logger.debug("[tag] Automix decision", { code: "FluentStream-automix-decision", detail: diagnostic })`, где `tag` — действующий `loggerTag` (по умолчанию `FluentStream`). Исключения logger тоже подавляются. Эта диагностика решений отделена от статистики микшера/буферизации `getPlaybackStats()` ниже.

Диагностика **не снижает** консервативные пороги безопасности выше и не меняет fallback: ненадёжные сетки или несовместимые темпы по-прежнему дают входящий **cue 0 без seek к drop**, даже с `explicitDropMs`.

**Цена и миграция.** Без кэша подготовка отдельно открывает/декодирует исходящий и входящий источники, затем снова открывает входящий для воспроизведения. Удалённые запросы передают URL/headers настроенному media endpoint и увеличивают сетевой трафик и CPU; внешнего сервиса анализа и встроенного кэша нет. Кэшируйте доверенный `DjAnalysis` в приложении (например, заранее через `analyzeTrack`); `analyzePcmAsync` не требует отдельной загрузки/декодирования библиотекой, если mono PCM уже доступен, и не выполняет CPU-анализатор в главном потоке. В ботах замените локальные импорты анализатора/planner публичными экспортами выше и удалите дублирующие реализации в проекте бота — оставьте одну библиотечную реализацию. Файлы ботов вне этого репозитория нужно мигрировать в их проекте. Их настройки playback/буферизации и downstream player здесь недоступны: сама изоляция анализа в worker не подтверждает исчезновение слышимых заиканий бота.

### Диагностика playback и benchmark отзывчивости

`streamer.getPlaybackStats()` возвращает `PlaybackMixerStats | null`: замороженный snapshot текущей mixed playback session либо `null` вне неё. Счётчики охватывают всю сессию микшера и не сбрасываются при чтении; для наблюдения изменений получите новый snapshot. Экспортируемый интерфейс соответствует `src/Audio/PlaybackMixer.ts`:

```ts
interface PlaybackMixerStats {
  readonly emittedFrames: number;
  readonly pullCount: number;
  readonly maxPullMs: number;
  readonly latePullCount: number;
  readonly deadlineMissCount: number;
  readonly pcmWaitMs: number;
  readonly maxPcmWaitMs: number;
  readonly frameShortageCount: number;
  readonly preparationWaitCount: number;
  readonly preparationWaitMs: number;
  readonly pendingReadCount: number;
  readonly prebufferedFrames: number;
  readonly preparing: boolean;
  readonly cleanupPending: boolean;
}
```

- `emittedFrames` — успешно поставленные в очередь PCM-кадры, включая fade/тишину, без отброшенной работы. `pullCount` включает первый запрос и терминальные pulls (EOF, ошибки, отмену).
- `maxPullMs` и `maxPcmWaitMs` — максимальная длительность generation pull; `pcmWaitMs` суммирует длительности pulls, включая ожидание PCM/подготовки, с фиксацией при завершении каждого pull. **Время между чтениями consumer не учитывается.** `latePullCount` считает pulls дольше `max(20 мс, длительность PCM, поставленного этим pull в очередь)`; `deadlineMissCount` — pulls строго дольше фиксированного дедлайна 20 мс (960 кадров при 48 кГц), включая первый/терминальные pulls.
- `frameShortageCount` считает ожидания кадров текущего источника дольше 20 мс, пока pull ещё не выдал output. Мгновенные/короткие чтения не являются shortage; задержанные EOF, ошибки и отмена могут учитываться. `preparationWaitCount` / `preparationWaitMs` описывают ожидание на EOF удерживаемой замены или прогрева входящего crossfade.
- `pendingReadCount` включает активные upstream reads, в том числе фоновую предбуферизацию. `prebufferedFrames` — полные кадры в явных warmup-очередях, не upstream chunks и не output. `preparing` и `cleanupPending` отражают текущее состояние подготовки/очистки.

Deadline misses и frame shortages **не являются физическими underruns плеера**. Блокировка event loop между pulls может не попасть в generation-only timing. Измеряйте доставку consumer по отдельным фиксированным часам вместе с задержкой event loop и телеметрией downstream/устройства; паузы consumer и внешняя буферизация отделены от генерации микшера.

Из корня репозитория запустите воспроизводимое синтетическое сравнение:

```sh
./node_modules/.bin/tsc && node scripts/bench-dj-responsiveness.mjs
```

Скрипт сравнивает baseline без анализа, два последовательных синхронных анализа и два параллельных worker-анализа на детерминированных seeded mono-треках по 90 секунд через настоящий `PlaybackMixer` с paced синтетическим PCM-источником. JSON содержит окружение, общее окно наблюдения по результатам калибровки, фиксированные 20-мс возможности доставки consumer/пропуски, задержку/утилизацию event loop и mixer stats. Время async включает запуск, копирование, DSP, IPC и завершение worker; отдельная оценка пустой задачи включает запуск/IPC/завершение, это не чистое время запуска и оно не вычитается из общего времени. Просроченные consumer slots пропускаются, а не воспроизводятся догоняющим burst.

Это короткое локальное наблюдение отзывчивости, **не worst-case input и не гарантия производительности**: 90 секунд — лимит анализа, не максимум вычислительной сложности. FFmpeg, сеть, устройство и физические underruns не измеряются; прямой mixer обходит throttling/настройки Processor. Повторите на целевой системе и сравните loop delay и consumer misses, а не только скорость анализа или счётчики микшера. Порогов времени для pass/fail нет; результаты конкретной машины не являются гарантиями API.

### Продвинутый пример стриминга

```ts
import { FluentStream } from "fluent-streamer";
import { Readable } from "node:stream";

// Стриминг из HTTP-источника в HTTP-ответ (например, в Express)
app.get("/audio/:fileId", async (req, res) => {
  const audioUrl = `https://cdn.example.com/audio/${req.params.fileId}.mp3`;

  try {
    const streamer = new FluentStream()
      .input(audioUrl)
      .setHeaders({
        Authorization: "Bearer token",
        "X-Client-Id": "my-app",
      })
      .audioCodec("aac")
      .audioBitrate("128k")
      .format("mp3")
      .output(FluentStream.stdout);

    const { output, done } = await streamer.run();

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'inline; filename="converted.mp3"');

    Readable.fromWeb(output).pipe(res);
    await done;
  } catch (error) {
    console.error("Ошибка стриминга аудио:", error);
    res.status(500).send("Streaming failed");
  }
});

```

### Аудиоэффекты в реальном времени

Встроенный DSP применяется **только к stdout с сырым PCM signed 16-bit little-endian (`s16le`)**, а не к файлам, которые FFmpeg пишет напрямую. MP3, AAC и WAV (контейнер с заголовком) нельзя передавать этому DSP. Для эффектов при записи файла нужно читать обработанный PCM и отдельно кодировать его либо использовать фильтры самого FFmpeg.

Пример PCM-воспроизведения в Node.js (нужны установленные `ffmpeg` и `ffplay`):

```ts
import { FluentStream } from "fluent-streamer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Writable } from "node:stream";

// Потребитель воспроизводит PCM и через backpressure ограничивает чтение.
// Эту функцию используют и следующие два примера.
function playPcm(output: ReadableStream<Uint8Array>): Promise<void> {
  const player = spawn("ffplay", [
    "-nodisp", "-autoexit",
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const exited = once(player, "exit").then(([code, signal]) => {
    if (code !== 0) throw new Error(`ffplay завершился: ${code ?? signal}`);
  });
  return Promise.all([
    output.pipeTo(Writable.toWeb(player.stdin)),
    exited,
  ]).then(() => {});
}

const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
  autoDrainOutput: false,
  disableThrottling: true, // Темп задаёт consumer, второй регулятор не нужен
  audioProcessorOptions: {
    volume: 1, bass: 0, treble: 0, mids: 0,
    compressor: false, normalize: false,
    sampleRate: 48000, channels: 2,
  },
});

const { output, done } = await streamer
  .input("music.mp3")
  .noVideo()
  .audioCodec("pcm_s16le")
  .format("s16le")
  .audioFrequency(48000)
  .audioChannels(2)
  .output("pipe:1")
  .run();

streamer.volume = 0.8; // Допустимый диапазон 0…1, усиления выше 1 нет
streamer.bass = 5;
streamer.treble = -3;
streamer.mids = 4;
streamer.changeNormalize(true); // Включаем нормализацию после run()

streamer.on("progress", (progress) => {
  console.log(`Время обработки: ${progress.outTime ?? "—"}`);
});

// Чтение output начинается до ожидания done.
await Promise.all([playPcm(output), done]);

```

Частота и число каналов в `audioProcessorOptions` должны совпадать с PCM FFmpeg: `.audioFrequency()`/`.audioChannels()` задают аргументы FFmpeg, но не перенастраивают DSP. Поддерживаются **mono (1 канал) и stereo (2 канала)**; другие значения `channels` вызывают `RangeError` в `AudioProcessor`.

Изменения bass/mids/treble сглаживаются за **50 мс аудиовремени**: переход отсчитывается по аудиокадрам (один сэмпл каждого канала), а не по таймеру, числу чанков или каналов. При 48000 Гц это 2400 кадров и для mono, и для stereo. Начальные значения конструктора `AudioProcessor` устанавливаются без перехода.

**Буферизация и задержка управления:**

* При 48000 Гц, stereo, s16le скорость составляет `48000 × 2 × 2 = 192000` байт/с; **20 мс = 3840 байт** (960 аудиокадров). Чанки stdout произвольного размера, библиотека не разбивает их на пакеты по 20 мс.
* Уже обработанный PCM в очередях (backlog) не меняется при новом значении эффекта. Чем больше очередь между DSP и устройством, тем позже изменение будет слышно. Backpressure от ограниченного consumer сдерживает чтение и рост очереди вверх по цепочке; чтение всего `output` в неограниченный массив эту защиту обходит.
* Стартовый буфер порядка **100–200 мс**, нарезка кадров, обработка underrun и дальнейший размер очереди — ответственность player/приложения. Библиотека не создаёт такой буфер автоматически; пример с `ffplay` использует его собственную буферизацию, а не гарантирует указанную задержку.
* Throttle опционален: `disableThrottling: true` по умолчанию. При `false` выдача ограничивается по `sampleRate × channels × 2` байт/с, но целыми входными чанками. Это **не jitter buffer**, не выравнивание пакетов и не защита от underrun. Если consumer уже задаёт темп воспроизведения, оставляйте `disableThrottling: true`.
* `autoDrainOutput: true` по умолчанию примерно через 100 мс начинает отбрасывать непрочитанный вывод, если поток не захвачен reader/pipe. Для собственного потребителя задайте `false` и читайте `output` параллельно с ожиданием `done`, иначе backpressure может остановить pipeline.

### Караоке (подавление центра)

В описанном выше PCM pipeline включите `useAudioProcessor: true` и `audioProcessorOptions.karaoke: true` (по умолчанию `false`) либо вызовите `streamer.setKaraoke(true)` до `run()`. Во время воспроизведения перезапуск не нужен:

```ts
streamer.setKaraoke(true);       // цепочечная начальная или живая настройка
streamer.karaoke = false;       // эквивалентный read/write accessor
const enabled = streamer.karaoke;
result.setKaraoke?.(true);      // результат run(), если подключён процессор
streamer.changeKaraoke(false);  // false, если runtime setter не подключён
```

`AudioProcessor` также предоставляет `setKaraoke(enabled)` и read/write accessor `karaoke`. `FluentAudioState` поддерживает это состояние, цепочечный setter и `changeKaraoke()`. Настройка Fluent сохраняется в кэшированных опциях/debug state для последующих запусков и переживает перезапуск при live seek.

Караоке использует mid/side-обработку: сохраняет боковую составляющую (side), частотно-избирательно ослабляет центральную (mid), затем восстанавливает стерео до громкости, EQ и компрессии. Полочные фильтры формируют ослабление примерно в диапазоне **180 Гц–6 кГц** с номинальной глубиной подавления центра **-24 дБ**. Адаптивная оценка когерентности по общей энергии mid относительно side — не анализ отдельных частот — уменьшает подавление сигналов, панорамированных полностью в один канал. **Моно обходит караоке**; остальные включённые эффекты продолжают работать.

Это **ослабление центра, а не ML-выделение вокала или разделение источников**. Центральные инструменты тоже могут ослабляться, а панорамированный вокал и вокальная реверберация — оставаться. Стерео сохраняется, но громкость и тембр могут измениться; ни полное удаление вокала, ни качество звучания не гарантируются. При восстановлении каналов пики могут выйти за допустимый диапазон, даже если исходный PCM не клиппировал; процессор ограничивает отсчёты 16-битным диапазоном (насыщение), предотвращая целочисленное переполнение. Такая обработка требует больше CPU, чем прежнее простое вычитание.

При переключении во время работы доля обработанного сигнала (wet) плавно меняется за **50 мс обрабатываемого аудио**; изначально включённая настройка действует сразу. Уже поставленный в очередь звук не обрабатывается повторно. Правила PCM-буферизации, 16-битного квантования, нормализации и насыщения остаются прежними. Для оценки ослабления начните с нейтрального EQ и отключённых нормализации/компрессии; эти эффекты доступны, но меняют остаточный звук.

### Плавное появление, затухание и переходы

Как и другие DSP-эффекты, fade работает с читаемым stdout PCM, а не с `.output("fade-demo.mp3")`. Используем `playPcm` из предыдущего примера:

```ts
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  useAudioProcessor: true,
  autoDrainOutput: false,
  disableThrottling: true,
  audioProcessorOptions: {
    volume: 0, bass: 0, treble: 0,
    compressor: false, normalize: false,
    sampleRate: 48000, channels: 2,
  },
})
  .input("background-music.mp3")
  .noVideo()
  .audioCodec("pcm_s16le")
  .format("s16le")
  .audioFrequency(48000)
  .audioChannels(2)
  .output("pipe:1");

const { output, done } = await streamer.run();
const fadeInTimer = setTimeout(() => streamer.fadeIn(1, 2000), 1000);
const fadeOutTimer = setTimeout(() => streamer.fadeOut(3000), 9000);
try {
  await Promise.all([playPcm(output), done]);
} finally {
  clearTimeout(fadeInTimer);
  clearTimeout(fadeOutTimer);
}

```

Таймеры задают момент команды, но сам fade отсчитывается по обрабатываемым аудиокадрам. Backlog player задерживает слышимый результат; без paced consumer файл может обработаться раньше срабатывания таймеров.

---

### Управление параметрами аудиопроцессора

Используем `playPcm` из примера выше; назначение — stdout PCM, а не файл WAV:

```ts
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
  autoDrainOutput: false,
  disableThrottling: true,
  audioProcessorOptions: {
    volume: 1, bass: 0, treble: 0,
    compressor: false, normalize: false,
    sampleRate: 48000, channels: 2,
  },
})
  .input("music.mp3")
  .setVolume(0.8)
  .setBass(8)
  .setTreble(-3)
  .setMids(4)
  .setCompressor(true)
  .noVideo()
  .audioCodec("pcm_s16le")
  .format("s16le")
  .audioFrequency(48000)
  .audioChannels(2)
  .output("pipe:1");

const { output, done } = await streamer.run();
await Promise.all([playPcm(output), done]);

```

---

## Обзор API

Класс `FluentStream` предоставляет удобный декларативный интерфейс:

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("song.mp3")
  .seekInput(30)          // перемотка на 30-ю секунду
  .audioCodec("opus")
  .audioBitrate("128k")
  .output("clip.opus")
  .run();

```

Основные методы:

* `.input(src)` — добавить входной файл/URL/стрим (`string`, `ReadableStream<Uint8Array>` или Node.js Readable).
* `.output(dst)` — задать назначение (путь к файлу, объект pipe или дескриптор).
* `.audioCodec(codec)` / `.videoCodec(codec)` — установить кодеки.
* `.audioBitrate(bps)` / `.videoBitrate(bps)` — установить битрейт.
* `.format(fmt)` — установить контейнер/формат вывода (например, 'mp3', 'wav').
* `.seekInput(time)` — задать начальное смещение до `.run()`.
* `await streamer.seek(time)` — выполнить live seek; возвращает новый результат запуска и выходной поток.
* `.overwrite()` — разрешить перезапись выходных файлов.
* `.map(spec)` — выбор конкретных дорожек/потоков (FFmpeg stream mapping).
* `.crossfadeAudio(seconds, options?)` — офлайн-фильтр FFmpeg для плавного перехода аудио.
* `await streamer.crossfade(url, seconds = 3)` — живой переход при `enableCrossfade: true`.
* `.setKaraoke(enabled)` / `.karaoke` — начальное/живое подавление центра.
* `.run()` — запустить процесс асинхронно (возвращает объект со ссылкой на `output`, промис `done` и функцию `stop`).

---

## Справочник по API

### Конструктор

```ts
new FluentStream(options?: ProcessorOptions)

```

Создает новый экземпляр `FluentStream` с необязательными глобальными конфигурациями.

**Параметры (Options):**

* `timeout?: number` - таймаут процесса FFmpeg в **миллисекундах** (`0` — отключён).
* `enableProgressTracking?: boolean` - включить генерацию событий прогресса.
* `failFast?: boolean` - немедленно останавливать обработку при первой ошибке.
* `wallTimeLimit?: number` - максимальный лимит астрономического времени работы.
* `useAudioProcessor?: boolean` - активировать встроенный аудиопроцессор для эффектов.
* `audioProcessorOptions?: AudioProcessingOptions` - параметры DSP (тип целиком приведён ниже; это не `Partial`).
* `enableCrossfade?: boolean` - явное включение (по умолчанию `false`) стабильного смешанного PCM-выхода и live `.crossfade()`; отключает auto-drain. См. [Live crossfade](#live-crossfade).
* `autoDrainOutput?: boolean` - автоматически читать и отбрасывать незахваченный stdout (по умолчанию `true`); для собственного consumer используйте `false`.
* `disableThrottling?: boolean` - отключить ограничение скорости stdout (по умолчанию `true`); при paced consumer оставляйте `true`.
* `logger?: Logger` - кастомный объект логгера (методы debug, info, warn, error).
* `verbose?: boolean` - включить подробный вывод отладочных логов.

Полный тип `AudioProcessingOptions` в 0.6.0:

```ts
interface AudioProcessingOptions {
  volume: number;     // Обязательно; 0…1
  bass: number;       // Обязательно; -20…20 дБ
  treble: number;     // Обязательно; -20…20 дБ
  mids?: number;     // По умолчанию 0; пользовательская шкала -20…20
  compressor: boolean; // Обязательно
  normalize: boolean;  // Обязательно
  karaoke?: boolean;   // По умолчанию false; подавление центра
  cloneInput?: boolean;
  sampleRate?: number;  // По умолчанию 48000
  channels?: number;    // По умолчанию 2; только 1 или 2
  headers?: Record<string, string>;
  lowPassFrequency?: number;
  lowPassQ?: number;
  fade?: {
    fadein: number;
    fadeout: number;
  };
}
```

При передаче `audioProcessorOptions` TypeScript требует все пять полей: `volume`, `bass`, `treble`, `compressor`, `normalize`. Сам объект необязателен. Наличие поля в типе не гарантирует его применение: текущий pipeline `FluentStream` передаёт в DSP громкость, EQ, компрессор, караоке, частоту и каналы, но не `cloneInput`, `headers`, `lowPassFrequency`, `lowPassQ` или `fade`; начальный `normalize` также сбрасывается в `false`. Для нормализации используйте `streamer.changeNormalize(true)` или `result.setNormalize?.(true)` **после** `run()`. У самостоятельного `new AudioProcessor(options)` начальный `normalize` применяется, а `cloneInput` управляет копированием PCM.

### Методы Ввода/Вывода

#### `.input(source: string | ReadableStream<Uint8Array> | NodeJS.Readable, options?: InputOptions)`

Добавить файл, URL, blob URL или входящий стрим.

```ts
// Файловый ввод
.input('/path/to/audio.mp3')

// HTTP URL с кастомными заголовками
.input('[https://cdn.com/track.mp3](https://cdn.com/track.mp3)')

// Ввод через Web Stream
.input(readableStream)

// Ввод через Node.js stream
.input(fs.createReadStream('input.wav'), { pipeIndex: 0 })

```

**Опции ввода (InputOptions):**

* `label?: string` - идентификатор/метка входного источника.
* `pipeIndex?: number` - кастомный индекс пайпа для стримов.
* `allowDuplicate?: boolean` - разрешить добавление дублирующихся источников.

#### `.output(destination: string | number | PipeObject)`

Задать цель вывода.

```ts
// Запись в файл (автоматически перезаписывается при вызове .overwrite())
.output('/path/to/output.mp4')

// Вывод в stdout / пайп
.output(FluentStream.stdout)
.output({ pipe: 'pipe:1' })

```

При работе с потоками используйте `pipe:1` для последующего чтения стрима `output` из результатов выполнения `.run()`.

### Конфигурация Аудио и Видео

#### `.audioCodec(codec: string)`

Установить аудиокодек: `'aac'`, `'mp3'`, `'opus'`, `'vorbis'`, `'pcm_s16le'` и т.д.

#### `.videoCodec(codec: string)`

Установить видеокодек: `'h264'`, `'h265'`, `'vp9'`, `'av1'`, `'mpeg4'` и т.д.

#### `.audioBitrate(bitrate: string)`

Установить аудиобитрейт: `'128k'`, `'192k'`, `'320k'`, `'variable'` и т.д.

#### `.videoBitrate(bitrate: string)`

Установить видеобитрейт: `'1M'`, `'2M'`, `'5M'`, `'10M'` и т.д.

#### `.format(format: string)`

Установить формат медиаконтейнера: `'mp3'`, `'mp4'`, `'wav'`, `'flac'`, `'webm'` и т.д.

#### `.audioFrequency(frequency: number)`

Установить частоту дискретизации: `44100`, `48000`, `96000` и т.д.

#### `.audioChannels(channels: number)`

Установить количество аудиоканалов: `1` (моно), `2` (стерео), `6` (5.1), `8` (7.1).

### Управление процессом

#### `.seekInput(position: number | string)`

Задать начальное смещение **до `.run()`**: `30`, `'00:00:30'`, `'1:30'` и т.д. Это настройка перед запуском, а не перемотка текущего воспроизведения; для активного запуска используйте `await streamer.seek(position)`.

#### `.duration(time: number | string)`

Ограничить общую длительность выходного медиа.

#### `.map(spec: string)`

Выбрать определенные дорожки (FFmpeg stream mapping):

```ts
.map('0:v')  // Выбрать только видео из первого источника
.map('1:a')  // Выбрать только аудио из второго источника
.map('0')    // Выбрать все дорожки из первого источника

```

#### `.noVideo()`, `.noAudio()`

Полностью отключить обработку видео или аудио соответственно.

#### `.overwrite()`

Разрешить перезапись существующих файлов на диске.

#### `.copyCodecs()`

Копировать потоки без перекодирования (режим `copy` — увеличивает скорость и сохраняет исходное качество).

### Аудиоэффекты (с поддержкой реального времени)

#### `.setVolume(value: number)`

Установить множитель громкости **0…1**: `0` (тишина), `0.5` (тише в два раза), `1` (исходный уровень). DSP ограничивает значения этим диапазоном; `1.5` не даёт усиления.

#### `.setBass(value: number)`

Настройка уровня баса (от -20 до 20 дБ): `0` (нейтрально), `5` (усиление), `-3` (срез).

#### `.setTreble(value: number)`

Настройка высоких частот (от -20 до 20 дБ): `0` (нейтрально), `5` (усиление), `-3` (срез).

#### `.setMids(value: number)`

Настройка средних частот (пользовательская шкала от -20 до 20, нелинейно преобразуемая в усиление до ±12 дБ): `0` — нейтрально, положительные значения — усиление, отрицательные — срез. Это широкий peaking-фильтр около 1 кГц с Q=0.7 (на низких частотах дискретизации центр ограничен `sampleRate × 0.45`). Доступны также свойство `mids` и опция `audioProcessorOptions.mids` (по умолчанию `0`). Значение Fluent-состояния сохраняется между запусками. Метод `setMids(value)` результата `run()` обновляет эффект на лету и сохраняет значение для следующего запуска того же `Processor`.

Сигнатура `AudioProcessor.setEqualizer(bass, treble, compressor)` остаётся прежней и не меняет mids; для средних используйте отдельный `setMids(value)`.

#### `.setCompressor(enabled: boolean)`

Включить/выключить динамический компрессор для выравнивания уровня звука.

#### `AudioProcessor.setEqualizer(bass, treble, compressor)`

Это метод отдельного `AudioProcessor`, не метод `FluentStream` и не поле результата `run()`. Он сохраняет прежнюю сигнатуру из трёх аргументов и **не меняет mids**. В fluent API используйте `.setBass()`, `.setTreble()`, `.setMids()` и `.setCompressor()` по отдельности; `changeEqualizer()` также отсутствует.

#### `.changeNormalize(enabled: boolean)`

Включить/выключить нормализацию на работающем процессоре; возвращает boolean. В результате `run()` доступен `setNormalize(enabled)`, у `AudioProcessor` — `setNormalize(enabled)` и свойство `normalize`.

Нормализатор оценивает пик входного PCM-блока по обоим каналам: целевой пик **−1 dBFS**, максимальное усиление **×4**. При пике не выше **−60 dBFS** усиление сбрасывается в 1 (тишина/шум не усиливаются). Уменьшение усиления — **instant attack**, восстановление — экспоненциальный **release 0.5 с**, рассчитанный по длительности аудио, а не числу чанков или wall-clock. Это не loudness/LUFS-нормализация и не финальный limiter: последующие volume/EQ/compressor могут изменить пик; результат ограничивается диапазоном int16.

#### `.setKaraoke(enabled: boolean)` / `.karaoke` / `result.setKaraoke?.(enabled)`
Настройка или переключение подавления центра при `useAudioProcessor: true`. `.setKaraoke()` поддерживает цепочку вызовов, `.karaoke` — read/write accessor. `.changeKaraoke()` возвращает наличие runtime setter. Поведение DSP и ограничения описаны в разделе [Караоке](#караоке-подавление-центра).

#### `.fadeIn(targetVolume?: number, durationMs?: number)`

Плавное повышение громкости от текущего уровня до целевого.

#### `.fadeOut(durationMs?: number)`

Плавное затухание звука до полной тишины.

**Изменение параметров "на лету" (во время выполнения):**

* `.changeVolume(value: number)` — возвращает boolean (успешно ли применено)
* `.changeBass(value: number)` — возвращает boolean
* `.changeTreble(value: number)` — возвращает boolean
* `.changeMids(value: number)` — возвращает boolean
* `.changeCompressor(enabled: boolean)` — возвращает boolean
* `.changeNormalize(enabled: boolean)` — возвращает boolean; вызывается после `run()`

### Продвинутые возможности

#### `.crossfadeAudio(duration: number, options?)`

Организовать плавное пересечение (кроссфейд) аудиодорожек с помощью встроенного фильтра `acrossfade`.

```ts
.crossfadeAudio(2.5, {
  curve1: 'tri',     // тип кривой затухания первого трека
  curve2: 'tri',     // тип кривой появления второго трека
  overlap: true,
  secondInput: 'path/to/second.mp3'
})

```

#### `.complexFilter(graph: string | string[])`

Добавить произвольные сложные графы фильтров FFmpeg (`-filter_complex`).

### Опции и Кастомизация Аргументов

#### `.setHeaders(headers: Record<string, string>)`

Передать кастомные HTTP-заголовки для сетевых источников запросов.

#### `.userAgent(userAgent: string)`

Установить кастомный User-Agent для HTTP-запросов.

#### `.globalOptions(...args)`, `.inputOptions(...args)`, `.outputOptions(...args)`

Добавление любых сырых аргументов FFmpeg в соответствующие позиции командной строки.

### Контроль Жизненного Цикла Жобы

#### `.run(options?) → Promise<FFmpegRunResultExtended>`

Запустить обработку. Возвращает объект:

```ts
{
  output: ReadableStream<Uint8Array>,  // Выходной стрим данных (при использовании pipe)
  done: Promise<void>,                 // Промис, разрешающийся при завершении или падающий при ошибке
  stop: () => void,                    // Функция для преднамеренной остановки (kill) процесса
  passthrough: ReadableStream<Uint8Array>,
  close: () => Promise<void> | void,
  seek?: (position: number | string) => Promise<FFmpegRunResultExtended>,
  crossfade?: (url: string, time?: number) => Promise<void>, // Смешанная сессия
  setVolume?, setBass?, setTreble?, setMids?, setCompressor?, setNormalize?, setKaraoke?, startFade?
}

```

Промис `done` успешно завершается при штатном окончании работы FFmpeg или при вызове `stop()`/`close()`. Промис отклоняется (reject) в случае ошибок спавна процесса, таймаутов или возврата ненулевого кода ошибки от FFmpeg. В Node.js системные сбои (например, `spawn ffmpeg ENOENT`) обрабатываются явно и всплывают как ошибки процесса, а не маскируются под неопределенный код завершения.

#### Live seek: `.seek(position)` / `result.seek?.(position)`

И `await streamer.seek(90)`, и `await result.seek?.('00:01:30')` выполняют переход к **абсолютной** позиции входного медиа, а не на относительное смещение. Опциональный метод результата должен присутствовать; иначе optional chaining вернёт `undefined`.

**Обычная перемотка (`enableCrossfade` выключен, поведение не изменилось):** FFmpeg перезапускается и возвращает **новый `FFmpegRunResultExtended`** со своими `output`, `done`, `stop` и остальными средствами управления. При перезапуске сохраняются текущие runtime-настройки громкости, EQ (bass/mids/treble), компрессора, караоке и нормализации. Заменяйте результат и output, как показано ниже:

```ts
const streamer = new FluentStream({ autoDrainOutput: false })
  .input('song.mp3')
  .audioCodec('pcm_s16le')
  .format('s16le')
  .output('pipe:1');

let result = await streamer.run();
let output = result.output;
// Подключите output к плееру и сохраните управление этим потребителем.

result = await streamer.seek(90);
output = result.output;
// Отключите старого потребителя, очистите очередь плеера и подключите НОВЫЙ output.

const next = await result.seek?.('00:01:30');
if (next) {
  result = next;
  output = result.output;
  // Снова замените потребителя и очистите очередь плеера до воспроизведения НОВОГО output.
}
// Далее используйте текущие result.done / result.stop и остальные методы управления.
```

При обычной перемотке старый выходной поток завершается. Приложение должно самостоятельно заменить потребляемый `output` и очистить очередь внешнего плеера: библиотека **не очищает её автоматически** и **не гарантирует gapless-воспроизведение**. Если приложение само читает выходной поток, рекомендуется `autoDrainOutput: false`.

**Жизненный цикл (обычные запуски без смешивания):** `done` относится к одному запуску FFmpeg, а не ко всей сессии воспроизведения. Завершение старого `done` (settled) при перезапуске **не означает конец playback session**. Не привязывайте безусловное завершение сессии/плеера к `done` старого результата: отслеживайте новый результат и отдельно обрабатывайте переход при перемотке.

**Перемотка в смешанной сессии (`enableCrossfade: true`):** Оба способа вызова seek возвращают **тот же публичный результат**, с **теми же `output` и `done`**. После завершённого crossfade позиция абсолютна внутри **текущего трека**, а не исходного трека или общей временной шкалы микса. Существующий consumer должен непрерывно читать output **до и на протяжении `await seek()`**: не отключайте его и не откладывайте чтение до завершения seek. Иначе backpressure может заблокировать завершение операции. `done` по-прежнему относится ко всей смешанной сессии, а не к новому декодеру.

Mixed seek выполняет fade-out старого звука за 20 мс, переключает декодер в тишине и выполняет fade-in от запрошенной позиции за 20 мс. Последовательные огибающие считаются по аудиокадрам и не меняют громкость пользователя или состояние DSP fade. `await seek()` завершается после формирования PCM fade-in, а не после физического воспроизведения; consumer должен продолжать чтение. Обычный seek с заменой output не использует эти огибающие микшера.


Например, в примере Live crossfade выше замените тело `try` на:

```ts
// playback уже читает result.output и должен продолжать чтение.
await streamer.crossfade("second.mp3", 3);
const sought = await streamer.seek(90); // абсолютная позиция 90 секунд в second.mp3
console.assert(sought === result);
console.assert(sought.output === result.output && sought.done === result.done);
await result.seek?.("00:00:30"); // то же поведение; абсолютная позиция 30 секунд в second.mp3
// При mixed seek не заменяйте result/output и не переподключайте consumer.
await Promise.all([playback, result.done]);
```

Библиотека **не очищает PCM, уже поставленный в очередь внешнего плеера**. Во время прогрева декодера могут продолжать звучать старые кадры, а запуск сетевого источника может вызвать слышимый разрыв. Сохранение потока **не гарантирует** немедленный слышимый переход или gapless-воспроизведение.

Seek во время активного fade отклоняется. Пока выполняется seek, crossfade и второй seek отклоняются. Эти операции **не отменяют и не замещают** текущий переход: дождитесь его завершения перед следующим запросом.

**Ограничения и ошибки:**
* Live seek поддерживается только для **активного** запуска с **одним повторно читаемым файлом/URL**, выводом в stdout (`pipe:1`) и **без complex filters**.
* Raw stream и blob-входы не поддерживаются. Live-сервер или URL без поддержки перемотки может привести к ошибке, даже если вход задан URL.
* Позиция — конечное число секунд `>= 0` либо строка времени, например `'00:01:30'`; это не относительное смещение.
* Конкурентные вызовы seek отклоняются (reject). При обычной перемотке вызов через устаревший результат, заменённый при seek, также отклоняется; всегда сохраняйте новый результат. В смешанной сессии seek сохраняет существующий публичный результат.
* `.seekInput()` остаётся настройкой перед запуском и не заменяет API live seek.

#### `.clear()`

Сбросить состояние экземпляра для его повторного использования (обязательно вызывать перед повторным запуском `.run()`).

#### `.isDirtyState()`, `.isReady()`

Проверить текущее состояние готовности билдера.

#### События экземпляра (Events)

* `'progress'` — обновление прогресса (если `enableProgressTracking: true`).
* `'error'` — критическая ошибка обработки.
* `'complete'` — успешное окончание выполнения задачи.
* `'start'` — запуск процесса FFmpeg.

### Статические свойства

#### Статические пайпы для вывода

* `FluentStream.stdout` — подставляет `{ pipe: 'stdout' }`
* `FluentStream.stderr` — подставляет `{ pipe: 'stderr' }`
* `FluentStream.pipe1` — подставляет `{ pipe: 'pipe:1' }`
* `FluentStream.pipe2` — подставляет `{ pipe: 'pipe:2' }`

---

## Продвинутые Темы

* **Таймауты:** Свойство `timeout` автоматически уничтожает зависшие/долгие процессы FFmpeg; при этом промис `done` отклоняется с ошибкой таймаута.
* **Прогресс:** События `"progress"` парсят stderr FFmpeg в реальном времени и возвращают объект с процентами, текущим временем и скоростью кодирования.
* **Заголовки:** По умолчанию для удаленных HTTP-источников отправляются базовые маскировочные заголовки; их можно кастомизировать через `.setHeaders(obj)`.
* **Контроль завершения:** Методы `stop()` и `close()` изолированы от системных сбоев FFmpeg, позволяя безопасно завершать воспроизведение/обработку по логике приложения.

---

## Архитектура проекта

* **Strict TypeScript:** Полная типобезопасность ядра (`FluentStream`, `Processor`).
* **Модульная структура:** Код разделен на независимые слои: `Fluent/` (построение API), `Core/` (выполнение процессов), `Runner/` (адаптеры под платформы), `Audio/` (контроллеры эффектов).
* **Встроенная обработка аудио:** Классы `AudioProcessor` и `AudioEffectController` манипулируют бинарными PCM-данными "на лету" без привлечения тяжелых сторонних утилит.
* **Расширяемые раннеры:** Вы можете написать свой класс на базе интерфейса `FFmpegRunner` для интеграции со специфичными средами выполнения или кастомного распределения памяти.

---

## Устранение неполадок (Troubleshooting)

### Часто встречающиеся проблемы

**FFmpeg не найден:**

```
Error: spawn ffmpeg ENOENT

```

* Убедитесь, что FFmpeg установлен в системе и добавлен в переменные окружения PATH.
* В Linux/macOS проверьте путь через терминал: `which ffmpeg`.
* В Windows убедитесь, что путь к директории с `ffmpeg.exe` прописан в системных переменных.
* Решение без изменения PATH: Передайте точный путь при инициализации: `new FluentStream({ ffmpegPath: '/usr/bin/ffmpeg' })`.

**Ошибки сети при работе с HTTP-источниками:**

```
[tcp @ 0x...] Connection refused

```

* Проверьте доступность ссылки: `curl -I https://example.com/audio.mp3`.
* Убедитесь, что брандмауэр или настройки прокси не блокируют исходящие запросы FFmpeg.
* Некоторые серверы могут банить запросы без валидных браузерных заголовков (используйте методы `.userAgent()` и `.setHeaders()`).

**Кодек или формат не поддерживается:**

```
Unknown encoder 'xxx' or unsupported codec

```

* Проверьте сборку FFmpeg на поддержку нужного кодека: `ffmpeg -codecs | grep xxx`.
* Для некоторых кодеков требуются non-free сборки FFmpeg (например, для fdk-aac).
* В качестве альтернативы попробуйте использовать более распространенные кодеки (например, `aac` вместо редких форматов).

**Исчерпание оперативной памяти (Out of memory):**

```
Cannot allocate memory

```

* Снизьте разрешение или частоту кадров (FPS) для видеопотоков.
* Используйте метод `copyCodecs()` там, где перекодирование не требуется.
* Ограничивайте количество одновременно запущенных инстансов `FluentStream` для контроля лимитов памяти.

### Советы по отладке

**Включение детального логирования:**

```ts
const streamer = new FluentStream({
  logger: console, // Передаем нативный консольный логгер
  verbose: true,   // Активируем вывод подробных сообщений
});

```

**Инспекция сгенерированных аргументов:**

```ts
const streamer = new FluentStream()
  .input('in.mp3')
  .audioCodec('aac')
  .output('out.m4a');

console.log('Аргументы FFmpeg:', streamer.getArgs());
console.log('Сводка входов:', streamer.getInputSummary());

```

---

## Разработка и контрибьютинг

### Сборка проекта

```bash
git clone [https://github.com/Dirold2/fluent-streamer.git](https://github.com/Dirold2/fluent-streamer.git)
cd fluent-streamer
npm install
npm run build
npm test

```

### Стандарты кодирования

* **TypeScript:** Обязательна строгая типизация (`strict: true`), код должен успешно проходить проверки oxlint.
* **Именование:** CamelCase для классов и типов, camelCase для методов, функций и свойств объектов.
* **Документация:** Каждое публичное свойство и метод должны снабжаться JSDoc-комментариями.
* **Тесты:** Проект покрывается тестами на базе Vitest; целевой показатель покрытия — не менее 90%.

---

## Лицензия

MIT © dirold2
