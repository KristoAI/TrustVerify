import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({entryPoints:["web/verification/diagnostics.ts"],bundle:true,write:false,format:"esm"});
const {recordDiagnostic,diagnosticReport,clearDiagnostics} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
test("diagnostic report excludes private fields, arbitrary strings and raw failures", () => {
  clearDiagnostics();
  recordDiagnostic("recognizing","progress",{progress:.5,attempt:1,text:"private OCR",birthDate:"1988-08-24",descriptor:[1,2],token:"secret",error:new Error("private")});
  recordDiagnostic("private stage", "failure", {});
  recordDiagnostic("document-result","failure",{code:"private error",durationMs:20});
  const report=diagnosticReport();
  assert.doesNotMatch(report,/private|secret|descriptor|birthDate|token/);
  assert.deepEqual(report.split("\n").map(JSON.parse),[
    {stage:"recognizing",status:"progress",attempt:1,progress:.5},
    {stage:"document-result",status:"failure",durationMs:20},
  ]);
});
test("diagnostic buffer is bounded and clears between attempts", () => {
  clearDiagnostics();
  for(let i=0;i<500;i++)recordDiagnostic("date-check","retry",{attempt:i});
  assert.equal(diagnosticReport().split("\n").length,256);
  clearDiagnostics();assert.equal(diagnosticReport(),"");
});
