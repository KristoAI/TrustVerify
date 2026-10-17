import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = "source/frontend/js/app/avs.js/";
const code = [
  "debug/documentDiagnostics.ts",
  "debug/log.ts",
  "plugin/handler.ts",
  "plugin/library/ml/tesseract.ts",
]
  .map(
    (file) =>
      ts.transpileModule(fs.readFileSync(sourceRoot + file, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2018 },
      }).outputText,
  )
  .join("\n");
const layout = () => ({
  tesseractConfig: {},
  stripWhiteSpace: false,
  textMatcherRule: ["/([0-9]{2})\\/([0-9]{2})\\/([0-9]{4})/gi"],
  dateComponentsPosition: [{ day: 1, month: 2, year: 3 }],
  monthNameLanguage: "en",
});
function setup(overrides = {}, config = layout()) {
  const logs = [],
    timers = new Map(),
    listeners = {};
  let timerId = 0,
    options;
  const worker = {
    load: async () => ({}),
    loadLanguage: async () => ({}),
    initialize: async () => ({}),
    setParameters: async () => ({}),
    recognize: async () => ({ data: { text: "21/04/1990" } }),
    terminate() {},
    ...overrides,
  };
  const context = vm.createContext({
    console: Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (message) => logs.push({ level, message }),
      ]),
    ),
    window: {
      addEventListener: (type, cb) => {
        listeners[type] = cb;
      },
      Tesseract: {
        createWorker: (value) => {
          options = value;
          return worker;
        },
      },
    },
    $: () => ({ get: () => null }),
    setTimeout: (cb) => {
      timers.set(++timerId, cb);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(code, context);
  const reader = new context.Avs.Plugin.Library.Ml.Tesseract(
    { idConfig: config, videoElementSelector: "#video", debugLevel: 4 },
    {},
    {},
  );
  const invoke = (method, ...args) =>
    new Promise((resolve) => reader[method](...args, resolve));
  const ready = async () => {
    for (const [method, args] of [
      ["loadWorker", []],
      ["loadLanguage", ["eng"]],
      ["initLanguage", ["eng"]],
      ["configureWorker", []],
    ])
      assert.equal(await invoke(method, ...args), true);
  };
  const events = () =>
    logs.map((row) =>
      JSON.parse(row.message.replace("[TrustBunny][document] ", "")),
    );
  return {
    reader,
    worker,
    invoke,
    ready,
    logs,
    events,
    timers,
    context,
    listeners,
    options,
  };
}

test("OCR failure retains its original stage and never dereferences a null result", async () => {
  const env = setup({
    recognize: async () => {
      throw new Error(
        "fetch failed: Private Name 21/04/1990 data:image/private",
      );
    },
  });
  await env.ready();
  assert.equal(await env.invoke("extractInformationFromId", {}), null);
  assert.equal(env.reader.lastFailure, "NETWORK_ERROR");
  assert.equal(env.events().at(-1).stage, "ocr-recognize");
  assert.equal(env.events().at(-1).status, "failure");
  assert.doesNotMatch(
    JSON.stringify(env.logs),
    /Private Name|21\/04\/1990|data:image/,
  );
  assert.equal(env.timers.size, 0);
});

test("successful date parsing emits only counts and stage outcomes", async () => {
  const env = setup();
  await env.ready();
  assert.equal(
    (await env.invoke("extractInformationFromId", {})).birthDate,
    "1990-04-21",
  );
  assert.equal(env.events().at(-1).stage, "date-parse");
  assert.equal(env.events().at(-1).status, "success");
  assert.doesNotMatch(JSON.stringify(env.logs), /1990|birthDate|"age"/);
});

test("empty OCR, unmatched patterns and invalid dates are distinct retryable outcomes", async () => {
  for (const [text, expected] of [
    ["   ", "EMPTY_TEXT"],
    ["SYNTHETIC UNMATCHED TEXT", "NO_DATE_MATCH"],
    ["31/02/1990", "INVALID_DATE"],
    ["01/01/2990", "INVALID_DATE"],
  ]) {
    const env = setup({ recognize: async () => ({ data: { text } }) });
    await env.ready();
    assert.equal(await env.invoke("extractInformationFromId", {}), null);
    assert.equal(env.reader.lastFailure, null);
    assert.equal(env.events().at(-1).code, expected);
    assert.equal(env.events().at(-1).status, "retry");
  }
});

test("malformed OCR results and date rules are diagnosed without throwing", async () => {
  for (const result of [null, {}, { data: {} }, { data: { text: 42 } }]) {
    const env = setup({ recognize: async () => result });
    await env.ready();
    assert.equal(await env.invoke("extractInformationFromId", {}), null);
    assert.equal(env.reader.lastFailure, "INVALID_RESULT");
  }
  for (const invalid of [
    { textMatcherRule: ["/[/gi"] },
    { dateComponentsPosition: [] },
    { monthNameLanguage: "not-supported" },
  ]) {
    const env = setup({}, { ...layout(), ...invalid });
    await env.ready();
    assert.equal(await env.invoke("extractInformationFromId", {}), null);
    assert.equal(env.reader.lastFailure, "INVALID_CONFIG");
  }
});

test("a failed reconfiguration clears ready state and blocks recognition", async () => {
  const env = setup();
  await env.ready();
  env.worker.setParameters = async () => {
    throw new Error("private failure");
  };
  assert.equal(await env.invoke("configureWorker"), null);
  assert.equal(env.reader.workerConfigured, false);
  assert.equal(await env.invoke("ocrImage", {}), null);
  assert.equal(env.events().at(-1).code, "NOT_READY");
});

test("timeout reports the exact stage, terminates worker and ignores late results", async () => {
  let resolveLoad,
    terminated = 0,
    callbacks = 0;
  const env = setup({
    load: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    terminate: () => terminated++,
  });
  env.reader.loadWorker((value) => {
    callbacks++;
    assert.equal(value, null);
  });
  [...env.timers.values()][0]();
  resolveLoad({});
  await Promise.resolve();
  assert.equal(callbacks, 1);
  assert.equal(terminated, 1);
  assert.equal(env.reader.workerLoaded, false);
  assert.equal(env.events().at(-1).stage, "worker-load");
  assert.equal(env.events().at(-1).code, "TIMEOUT");
});

test("native worker errors and library errorHandler return a single sanitized failure", async () => {
  for (const native of [false, true]) {
    let onError, reject;
    const env = setup({
      worker: {
        addEventListener: (type, cb) => {
          onError = cb;
        },
      },
      load: () =>
        new Promise((resolve, rej) => {
          reject = rej;
        }),
    });
    let callbacks = 0;
    env.reader.loadWorker((value) => {
      callbacks++;
      assert.equal(value, null);
    });
    const event = { message: "Private birth date", preventDefault() {} };
    if (native) onError(event);
    else env.options.errorHandler(event);
    reject(event);
    await Promise.resolve();
    assert.equal(callbacks, 1);
    assert.doesNotMatch(JSON.stringify(env.logs), /Private birth date/);
  }
});

test("diagnostic allowlist drops arbitrary fields, strings, error content and unknown progress", () => {
  const env = setup();
  env.context.Avs.Debug.DocumentDiagnostics.emit("ocr-text", "success", {
    characterCount: 5,
    birthDate: "1990-04-21",
    image: "data:image/private",
    width: "private",
    age: 36,
  });
  env.options.logger({ status: "private OCR text", progress: 0.5 });
  env.listeners.securitypolicyviolation({
    effectiveDirective: "worker-src",
    blockedURI: "data:image/private",
    sourceFile: "?token=private",
  });
  assert.doesNotMatch(JSON.stringify(env.logs), /private|1990|birthDate|"age"/);
  assert.equal(env.events().at(-1).code, "CSP_BLOCKED");
  assert.equal(env.events().at(-2).characterCount, 5);
});

function loadHelper(env, file) {
  vm.runInContext(
    ts.transpileModule(fs.readFileSync(sourceRoot + file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2018 },
    }).outputText,
    env.context,
  );
}

test("crop coordinates are stable by default and explicit retry offsets stay bounded", () => {
  const env = setup();
  loadHelper(env, "helper/elementPositionCalculator.ts");
  loadHelper(env, "helper/documentOcr.ts");
  const calculator = env.context.Avs.Helper.ElementPositionCalculator;
  const face = { width: 114, top: 146, left: 41 };
  const config = {
    faceArea: { width: 114, birthDateAreaDistance: { top: 2, left: 187 } },
    birthDateArea: { width: 109, height: 28 },
  };
  const first = calculator.calculateBirthDateMaskPosition(face, config);
  assert.equal(first.left, 228);
  assert.equal(first.top, 148);
  assert.equal(first.width, 109);
  for (let attempt = 0; attempt < 50; attempt++) {
    const settings = env.context.Avs.Helper.DocumentOcr.attempt(attempt, 2);
    assert.ok(Math.abs(settings.scaleAdjustment) <= 0.1);
    if (attempt < 2) {
      assert.equal(settings.grayscale, false);
      assert.equal(settings.brightness, 0);
      assert.equal(settings.contrast, 0);
      assert.equal(settings.scaleAdjustment, 0);
    }
    assert.equal(
      JSON.stringify(calculator.calculateBirthDateMaskPosition(face, config)),
      JSON.stringify(first),
    );
  }
});

test("both Florida license layouts parse synthetic US dates and configure a cropped text mode", async () => {
  const env = setup();
  loadHelper(env, "config/scanId.ts");
  const layouts =
    env.context.Avs.Config.scanIdList.US.stateList.FL.idConfig.driverLicence;
  assert.equal(layouts.length, 2);
  for (let i = 0; i < layouts.length; i++) {
    const text = i === 0 ? "04-21-1990" : "04/21/1990";
    let parameters;
    const reader = setup(
      {
        recognize: async () => ({ data: { text } }),
        setParameters: async (params) => {
          parameters = params;
          return {};
        },
      },
      layouts[i],
    );
    await reader.ready();
    assert.equal(parameters.tessedit_pageseg_mode, 6);
    assert.equal(
      (await reader.invoke("extractInformationFromId", {})).birthDate,
      "1990-04-21",
    );
    await new Promise((resolve) =>
      reader.reader.setIdConfig(layouts[i], resolve, 7),
    );
    assert.equal(parameters.tessedit_pageseg_mode, 7);
    assert.equal(layouts[i].tesseractConfig.tessedit_pageseg_mode, undefined);
  }
});

test("expected retries have no warning stack and the bounded report contains only sanitized events", () => {
  const env = setup(),
    diagnostics = env.context.Avs.Debug.DocumentDiagnostics;
  diagnostics.begin();
  diagnostics.setAttempt(2, 1, 0);
  for (let i = 0; i < 1005; i++)
    diagnostics.emit(
      "date-match",
      "retry",
      { text: "PRIVATE", image: "PRIVATE" },
      "NO_DATE_MATCH",
    );
  const report = diagnostics.getReport().split("\n");
  assert.equal(report.length, 1000);
  assert.doesNotMatch(report.join("\n"), /PRIVATE/);
  assert.equal(env.logs.at(-1).level, "info");
  assert.equal(env.events().at(-1).attempt, 2);
  assert.equal(env.events().at(-1).occurrences, 1005);
  diagnostics.emit("document-result", "failure", {}, "VERIFICATION_FAILED");
  assert.equal(
    env.events().at(-1).retryCounts["date-match:NO_DATE_MATCH"],
    1005,
  );
  diagnostics.begin();
  assert.equal(diagnostics.getReport(), "");
});

test("camera capability probe never requests microphone access and stops its temporary stream", async () => {
  const env = setup();
  let request,
    stopped = 0;
  env.context.navigator = {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        request = constraints;
        return {
          getTracks: () => [
            {
              stop() {
                stopped++;
              },
            },
          ],
        };
      },
    },
  };
  loadHelper(env, "helper/common.ts");
  assert.equal(
    await new Promise((resolve) =>
      env.context.Avs.Helper.Common.hasCameraFacingMode("environment", resolve),
    ),
    true,
  );
  assert.equal(request.audio, false);
  assert.equal(stopped, 1);
});

test("selected crop bounds cannot address pixels outside the document", () => {
  const env = setup();
  loadHelper(env, "helper/documentOcr.ts");
  const clamp = env.context.Avs.Helper.DocumentOcr.clampRegion;
  const r = clamp(
    { left: 590, top: 390, width: 200, height: 50, scalePercent: 1 },
    600,
    400,
  );
  assert.equal(r.width, 10);
  assert.equal(r.height, 10);
  const negative = clamp(
    { left: -20, top: -5, width: 100, height: 50, scalePercent: 1 },
    600,
    400,
  );
  assert.equal(negative.left, 0);
  assert.equal(negative.top, 0);
  assert.throws(() =>
    clamp({ left: NaN, top: 0, width: 100, height: 50 }, 600, 400),
  );
  assert.throws(() =>
    clamp({ left: 0, top: 0, width: 0, height: 50 }, 600, 400),
  );
});

test("unreadable automatic or selected crops pause for review and never grant verification", () => {
  const env = setup();
  const scan = {
    validScanNumber: 0,
    totalScanNumber: 8,
    getIdVariantCount: () => 2,
    lowestScanValue: 0,
  };
  env.context.instance = {
    entity: {
      ScanIdAgeVerification: scan,
      VerificationStepGlobal: { verificationComplete: false },
    },
  };
  env.context.Config = {
    MAX_VALID_DATA_EXTRACTION_NUMBER: 1,
    MAX_TOTAL_DATA_EXTRACTION_NUMBER: 50,
    DATA_EXTRACTION_INTERVAL_MS: 500,
  };
  env.context.Application = { requiredAge: 18 };
  const code = ts.transpileModule(
    fs.readFileSync(
      "source/frontend/js/app/avsFactory.js/scanIdAgeVerificationPage/30-method.ts",
      "utf8",
    ),
    { compilerOptions: { target: ts.ScriptTarget.ES2018 } },
  ).outputText;
  vm.runInContext(code, env.context);
  const method = env.context.AvsFactory.ScanIdAgeVerificationPage.Method;
  let review = 0,
    success = 0,
    failCode;
  method.showCropReview = () => review++;
  method.goToSuccessStep = () => success++;
  method.goToFailStep = (code) => {
    failCode = code;
  };
  method.checkOcrStep();
  assert.equal(review, 1);
  assert.equal(success, 0);
  assert.equal(failCode, undefined);
  assert.equal(
    env.context.instance.entity.VerificationStepGlobal.verificationComplete,
    false,
  );
  // User-guided reading gets a fresh bounded round, without clearing or accepting the old result.
  method.readingRoundStart = 8;
  scan.totalScanNumber = 16;
  method.checkOcrStep();
  assert.equal(review, 2);
  assert.equal(success, 0);
  assert.equal(failCode, undefined);
  scan.validScanNumber = 1;
  scan.lowestScanValue = 12;
  method.checkOcrStep();
  assert.equal(failCode, 25053);
  assert.equal(success, 0);
  scan.lowestScanValue = 30;
  method.checkOcrStep();
  assert.equal(success, 1);
  assert.equal(
    env.context.instance.entity.VerificationStepGlobal.verificationComplete,
    true,
  );
});

test("compact ID preview maps guide to native camera pixels regardless of screen offset", () => {
  const env = setup();
  loadHelper(env, "helper/videoAreaExtractor.ts");
  const map = env.context.Avs.Helper.VideoAreaExtractor.mapMaskToSource;
  const atOrigin = map(
    { left: 20, top: 15, width: 280, height: 170 },
    { left: 0, top: 0, width: 320, height: 200 },
    1920,
    1080,
  );
  const moved = map(
    { left: 500, top: 105, width: 280, height: 170 },
    { left: 480, top: 90, width: 320, height: 200 },
    1920,
    1080,
  );
  assert.equal(JSON.stringify(atOrigin), JSON.stringify(moved));
  assert.equal(moved.width, 1512);
  assert.equal(moved.height, 918);
  const asym = map(
    { left: 500, top: 105, width: 140, height: 170 },
    { left: 480, top: 90, width: 320, height: 200 },
    1920,
    1080,
  );
  const mirror = map(
    { left: 500, top: 105, width: 140, height: 170 },
    { left: 480, top: 90, width: 320, height: 200 },
    1920,
    1080,
    true,
  );
  assert.equal(mirror.left, 1920 - asym.left - asym.width);
  const portrait = map(
    { left: 26, top: 106, width: 168, height: 288 },
    { left: 10, top: 90, width: 200, height: 320 },
    1080,
    1920,
  );
  assert.ok(portrait.width > 168);
  assert.ok(portrait.height > 288);
  assert.throws(() =>
    map(
      { left: 0, top: 0, width: 300, height: 200 },
      { left: 0, top: 0, width: 300, height: 200 },
      0,
      0,
    ),
  );
});

test("camera-ready and failure events synchronize native and internal photo-button state", () => {
  const env = setup();
  let disabled = true,
    clickHandler,
    captures = 0;
  const classes = new Set();
  const element = {
    is: () => true,
    attr(name, value) {
      if (arguments.length === 1) return disabled ? "disabled" : undefined;
      disabled = !!value;
      return this;
    },
    prop(name, value) {
      disabled = !!value;
      return this;
    },
    hasClass: (name) => classes.has(name),
    addClass(name) {
      classes.add(name);
      return this;
    },
    removeClass(name) {
      classes.delete(name);
      return this;
    },
    click(cb) {
      clickHandler = cb;
      return this;
    },
    unbind() {
      clickHandler = null;
      return this;
    },
    text() {
      return this;
    },
  };
  env.context.$ = () => element;
  const files = [
    "ui/handler/_common.ts",
    "ui/handler/button.ts",
    "entity/ui.ts",
    "ui/library/button/scanIdAgeVerificationTakePhotoButton.ts",
  ];
  // Compile together so TypeScript can resolve the legacy namespace inheritance.
  vm.runInContext(
    ts.transpileModule(
      files.map((f) => fs.readFileSync(sourceRoot + f, "utf8")).join("\n"),
      { compilerOptions: { target: ts.ScriptTarget.ES2018 } },
    ).outputText,
    env.context,
  );
  const handlers = {};
  const button =
    new env.context.Avs.Ui.Library.ScanIdAgeVerificationTakePhotoButton({});
  button.onClick(() => captures++);
  env.context.instance = {
    event: { on: (name, cb) => (handlers[name] = cb) },
    ui: {
      ScanIdAgeVerificationTakePhotoButton: button,
      ScanIdAgeVerificationLoadingLabelArea: { setContent() {}, hide() {} },
    },
  };
  env.context.Config = { EVENT_NAME_PREFIX: "id" };
  env.context.Method = { repositionScanId() {} };
  env.context.Avs.DataChannel = {
    Webrtc: { ON_WEBCAM_INIT_ERROR: "error", ON_VIDEO_PLAY: "play" },
  };
  vm.runInContext(
    ts.transpileModule(
      fs.readFileSync(
        "source/frontend/js/app/avsFactory.js/scanIdAgeVerificationPage/40-event.ts",
        "utf8",
      ),
      { compilerOptions: { target: ts.ScriptTarget.ES2018 } },
    ).outputText,
    env.context,
  );
  env.context.AvsFactory.ScanIdAgeVerificationPage.Event.init();
  clickHandler();
  assert.equal(captures, 0);
  assert.equal(button.states.enabled, false);
  handlers["id.play"]();
  assert.equal(disabled, false);
  assert.equal(button.states.enabled, true);
  clickHandler();
  assert.equal(captures, 1);
  handlers["id.error"]();
  assert.equal(disabled, true);
  assert.equal(button.states.enabled, false);
  clickHandler();
  assert.equal(captures, 1);
  handlers["id.play"]();
  clickHandler();
  assert.equal(captures, 2);
});
