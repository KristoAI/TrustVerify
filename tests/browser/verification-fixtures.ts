import { readDocument } from '../../web/verification/document';
import { createOCRReader } from '../../web/verification/ocr';
import { clearDiagnostics, diagnosticReport } from '../../web/verification/diagnostics';
import { inspectFaces } from '../../web/verification/face';
import QRCode from 'qrcode';
const status = document.querySelector<HTMLElement>('#status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#fixture')!;
const fixtureSession = new URL(location.href).searchParams.get('session');
const syntheticPhone = document.querySelector<HTMLButtonElement>('#synthetic-phone')!;
if (fixtureSession && /^[0-9a-f-]{36}$/.test(fixtureSession)) {
  syntheticPhone.hidden = false;
  syntheticPhone.onclick = async () => {
    syntheticPhone.disabled = true;
    const response = await fetch(`/api/continuation/${fixtureSession}/finish`, {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({outcome:'success',method:'selfie'}),
    });
    status.textContent = response.ok ? 'PASS: synthetic phone outcome committed in local test database' : 'FAIL: phone authority rejected';
  };
}
function image(text: string) {
  canvas.width=1200; canvas.height=180;
  const c=canvas.getContext('2d')!;
  c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);
  c.fillStyle='#000';c.font='48px Arial';c.fillText(text,40,105);
}
document.querySelector<HTMLButtonElement>('#ocr')!.onclick=async function() {
  this.disabled=true; status.textContent='Running English OCR';
  try {
    image('DOB 08/24/1988');
    const eng=await readDocument({image:canvas,language:'eng',dateOrder:'MDY'});
    if(JSON.stringify(eng.birthDate)!==JSON.stringify({year:1988,month:8,day:24})) throw new Error('English date mismatch');
    status.textContent='Running French OCR';image('DATE DE NAISSANCE 24/08/1988');
    const fra=await readDocument({image:canvas,language:'fra',dateOrder:'DMY'});
    if(fra.birthDate.year!==1988||fra.birthDate.month!==8||fra.birthDate.day!==24)throw new Error('French date mismatch');
    image('08/24/1988');
    const crop=await readDocument({image:canvas,language:'eng',dateOrder:'MDY',crop:{x:0,y:0,width:1,height:1}});
    if(crop.source!=='selected-region'||crop.birthDate.year!==1988)throw new Error('Selected crop mismatch');
    status.textContent='PASS: real English, French and selected-region OCR';
  }catch(error){status.textContent='FAIL: '+(error instanceof Error?error.message:'Unknown fixture failure');}
  finally{this.disabled=false;}
};
document.querySelector<HTMLButtonElement>('#models')!.onclick=async function(){
  this.disabled=true;status.textContent='Loading models and running blank-image inference';
  try{image('');const faces=await inspectFaces(canvas,new AbortController().signal);status.textContent=faces.length===0?'PASS: models loaded; blank image has no face':'FAIL: unexpected blank-image face';}
  catch(error){status.textContent='FAIL: '+(error instanceof Error?error.message:'Model error');}finally{this.disabled=false;}
};
document.querySelector<HTMLButtonElement>('#qr')!.onclick=async()=>{
  await QRCode.toCanvas(canvas,'https://example.test/continue-phone#synthetic-test',{margin:4,width:280,errorCorrectionLevel:'M'});
  status.textContent='PASS: MIT QR encoder rendered the synthetic continuation URL';
};

document.querySelector<HTMLButtonElement>('#mrz')!.onclick=async function(){
  this.disabled=true;status.textContent='Reading synthetic ICAO MRZ with the real OCR reader';
  let diagnostics=document.querySelector<HTMLPreElement>('#mrz-diagnostics');
  if(!diagnostics){diagnostics=document.createElement('pre');diagnostics.id='mrz-diagnostics';canvas.after(diagnostics);}
  diagnostics.textContent='Synthetic fixture OCR text (not production document data):\n';
  try {
    canvas.width=1400;canvas.height=240;
    const context=canvas.getContext('2d')!;
    context.fillStyle='#fff';context.fillRect(0,0,1400,240);
    context.fillStyle='#000';context.font='42px monospace';
    context.fillText('PPUTOERIKSSON<<ANNA<MARIA'.padEnd(44,'<'),40,95);
    context.fillText('L898902C36UTO7408122F3404159ZE184226B<<<<<16',40,165);
    const reader=createOCRReader();
    try { await reader.load(); diagnostics.textContent+=JSON.stringify((await reader.recognize(canvas)).data?.text)+'\n'; } finally { reader.terminate(); }
    const result=await readDocument({image:canvas,language:'eng',dateOrder:'DMY'});
    status.textContent=result.source==='mrz' && result.birthDate.year===1974 && result.birthDate.month===8 && result.birthDate.day===12 ? 'PASS: real OCR and checked MRZ returned synthetic 1974-08-12' : 'FAIL: MRZ fixture result mismatch';
  }catch(error){status.textContent='FAIL: '+(error instanceof Error?error.message:'MRZ fixture failure');}
  finally{this.disabled=false;}
};


// Synthetic multi-column card: no real identity or private image is used.
document.querySelector<HTMLButtonElement>('#spatial-ocr')!.onclick = async function() {
  this.disabled = true;
  status.textContent = 'Reading a synthetic card with DOB and issue date in separate columns';
  clearDiagnostics();
  try {
    drawCard(0);
    const result = await readDocument({ image: canvas, language: 'eng', dateOrder: 'MDY' });
    if (result.birthDate.year !== 1988 || result.birthDate.month !== 8 || result.birthDate.day !== 24 || result.source !== 'label') throw new Error('Wrong synthetic DOB field');
    const attempts = diagnosticReport().split('\n').filter(line => line.includes('"preparing-image"') && line.includes('"start"') && line.includes('"attempt"'));
    if (attempts.length !== 2 || !diagnosticReport().includes('"date-check","status":"retry"')) throw new Error('Expected one focused reread');
    status.textContent = 'PASS: real OCR located the DOB column and reread its crop in exactly 2 attempts; issue and expiry dates excluded';
  } catch(error) { status.textContent = 'FAIL: ' + (error instanceof Error ? error.message : 'Synthetic OCR error'); }
  finally { this.disabled = false; }
};

// The same synthetic card photographed at an angle: the reader levels it before locating fields.
document.querySelector<HTMLButtonElement>('#tilted-ocr')!.onclick = async function() {
  this.disabled = true;
  try {
    for (const degrees of [4, 10]) {
      status.textContent = `Reading the synthetic card tilted ${degrees} degrees`;
      drawCard(degrees);
      const result = await readDocument({ image: canvas, language: 'eng', dateOrder: 'MDY' });
      if (result.birthDate.year !== 1988 || result.birthDate.month !== 8 || result.birthDate.day !== 24 || result.source !== 'label') throw new Error(`Wrong DOB at ${degrees} degrees`);
    }
    status.textContent = 'PASS: real OCR levelled 4 and 10 degree tilted cards and read the DOB field';
  } catch(error) { status.textContent = 'FAIL: ' + (error instanceof Error ? error.message : 'Synthetic OCR error'); }
  finally { this.disabled = false; }
};

function drawCard(degrees: number) {
  canvas.width = 1200; canvas.height = 760;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#d9d4ca'; c.fillRect(0, 0, 1200, 760);
  c.save(); c.translate(600, 380); c.rotate(-degrees * Math.PI / 180); c.translate(-600, -380);
  c.scale(.82, .82); c.translate(130, 80);
  {
    c.fillStyle = '#ece8df'; c.fillRect(0, 0, 1200, 760);
    c.fillStyle = '#172629'; c.font = '40px Arial';
    c.fillText('SYNTHETIC DOCUMENT - TEST ONLY', 65, 95);
    c.font = '24px Arial';
    c.fillText('3 DOB', 100, 320); c.fillText('4a ISS', 690, 320);
    c.font = '40px Arial';
    c.fillText('08/24/1988', 100, 380); c.fillText('01/02/2020', 690, 380);
    c.font = '30px Arial'; c.fillText('EXP 08/24/2030', 690, 600);
  }
  c.restore();
}
