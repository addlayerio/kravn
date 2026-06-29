import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';
import { loadPyodide, type PyodideInterface } from 'pyodide';

// Cap this worker's WASM linear memory (64KiB pages) BEFORE Pyodide creates its heap, so a runaway
// allocation fails with a Python MemoryError instead of growing the host process toward ~4GB.
v8.setFlagsFromString('--wasm-max-mem-pages=12288'); // 12288 * 64KiB = 768 MB

/**
 * Worker thread that runs model-generated Python in a Pyodide (CPython→WASM) sandbox.
 * WASM has no host filesystem/network access; files are passed in/out explicitly via base64.
 * The main thread enforces a hard timeout by terminate()-ing this worker.
 */

// Pure-Python wheels bundled for offline Excel I/O (no micropip / no network).
const WHEELS = ['et_xmlfile-2.0.0-py3-none-any.whl', 'openpyxl-3.1.5-py2.py3-none-any.whl'];
const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/pyodide-wheels');

const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;
const MAX_OUTPUT_FILES = 10;
const MAX_LOG = 20_000;

interface RunMsg { code: string; files?: { name: string; b64: string }[] }
interface OutFile { name: string; b64: string; mime: string; size: number }

let pyPromise: Promise<PyodideInterface> | null = null;

async function getPy(): Promise<PyodideInterface> {
  if (!pyPromise) {
    pyPromise = (async () => {
      const py = await loadPyodide();
      py.FS.mkdirTree('/wheels');
      py.FS.mkdirTree('/site');
      for (const w of WHEELS) {
        const p = path.join(ASSET_DIR, w);
        if (fs.existsSync(p)) py.FS.writeFile(`/wheels/${w}`, fs.readFileSync(p));
      }
      // A .whl is a zip; extracting pure-Python wheels into a path on sys.path makes them importable.
      py.runPython(`
import sys, zipfile, glob
for whl in sorted(glob.glob('/wheels/*.whl')):
    try:
        zipfile.ZipFile(whl).extractall('/site')
    except Exception:
        pass
if '/site' not in sys.path:
    sys.path.insert(0, '/site')
`);
      return py;
    })();
  }
  return pyPromise;
}

function mimeFor(name: string): string {
  const e = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    html: 'text/html',
  };
  return map[e] ?? 'application/octet-stream';
}

parentPort!.on('message', async (msg: RunMsg) => {
  try {
    const py = await getPy();

    // Fresh working dir each run.
    py.runPython(`
import shutil, os
shutil.rmtree('/work', ignore_errors=True)
os.makedirs('/work', exist_ok=True)
os.chdir('/work')
`);

    const inputNames = new Set<string>();
    for (const f of msg.files ?? []) {
      const safe = path.basename(f.name); // no traversal
      py.FS.writeFile(`/work/${safe}`, Buffer.from(f.b64, 'base64'));
      inputNames.add(safe);
    }

    py.globals.set('USER_CODE', msg.code);
    py.runPython(`
import io, contextlib, traceback
_out, _err = io.StringIO(), io.StringIO()
_ok = True
with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_err):
    try:
        exec(compile(USER_CODE, '<cell>', 'exec'), {'__name__': '__main__'})
    except SystemExit:
        pass
    except BaseException:
        _ok = False
        traceback.print_exc(file=_err)
RESULT_OUT, RESULT_ERR, RESULT_OK = _out.getvalue(), _err.getvalue(), _ok
`);

    const stdout = String(py.globals.get('RESULT_OUT') ?? '').slice(0, MAX_LOG);
    const stderr = String(py.globals.get('RESULT_ERR') ?? '').slice(0, MAX_LOG);
    const ok = Boolean(py.globals.get('RESULT_OK'));

    // Outputs = files left in /work that weren't inputs.
    const outputs: OutFile[] = [];
    let total = 0;
    for (const name of py.FS.readdir('/work') as string[]) {
      if (name === '.' || name === '..' || inputNames.has(name)) continue;
      let st;
      try {
        st = py.FS.stat(`/work/${name}`);
      } catch {
        continue;
      }
      if (py.FS.isDir(st.mode)) continue;
      const bytes = py.FS.readFile(`/work/${name}`) as Uint8Array;
      total += bytes.length;
      if (total > MAX_OUTPUT_BYTES || outputs.length >= MAX_OUTPUT_FILES) break;
      outputs.push({ name, b64: Buffer.from(bytes).toString('base64'), mime: mimeFor(name), size: bytes.length });
    }

    parentPort!.postMessage({ ok, stdout, stderr, outputs });
  } catch (err) {
    parentPort!.postMessage({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), outputs: [] });
  }
});
