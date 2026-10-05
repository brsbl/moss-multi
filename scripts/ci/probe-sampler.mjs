// T0.9d probe (temporary): every 200 ms, per-thread CPU and state of workerd and node, system CPU incl. iowait, and
// wrangler.log lines stamped as they appear. Usage: node probe-sampler.mjs <wrangler.log> <out>
import { appendFileSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';

const [logPath, out] = process.argv.slice(2);
let offset = 0; let carry = '';
let lastSys = null; const lastTask = new Map();
const write = (line) => appendFileSync(out, line + '\n');
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
function tick() {
  const t = (performance.timeOrigin + performance.now()) / 1000;
  const stamp = new Date(t * 1000).toISOString().slice(11, 23);
  const sys = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (lastSys) {
    const d = sys.map((v, i) => v - lastSys[i]); const total = d.reduce((a, b) => a + b, 0) || 1;
    const pct = (i) => Math.round((d[i] / total) * 100);
    const parts = [`S ${stamp} us=${pct(0)} ni=${pct(1)} sy=${pct(2)} id=${pct(3)} wa=${pct(4)}`];
    for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      const comm = read(`/proc/${pid}/comm`).trim();
      if (comm !== 'workerd' && comm !== 'node' && !comm.startsWith('WPE') && comm !== 'MainThread') continue;
      let tasks = []; try { tasks = readdirSync(`/proc/${pid}/task`); } catch { continue; }
      for (const tid of tasks) {
        const stat = read(`/proc/${pid}/task/${tid}/stat`); if (!stat) continue;
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const state = after[0]; const ticks = Number(after[11]) + Number(after[12]);
        const key = `${pid}/${tid}`; const prev = lastTask.get(key); lastTask.set(key, ticks);
        const used = prev === undefined ? 0 : ticks - prev;
        if (used > 0 || state === 'D' || (comm === 'workerd' && state === 'R')) {
          const tcomm = read(`/proc/${pid}/task/${tid}/comm`).trim();
          const wchan = state === 'D' ? read(`/proc/${pid}/task/${tid}/wchan`) : '';
          parts.push(`${comm}:${pid}/${tcomm}:${tid} ${state} ${used}${wchan ? ' ' + wchan : ''}`);
        }
      }
    }
    write(parts.join(' | '));
  }
  lastSys = sys;
  if (existsSync(logPath)) {
    const size = statSync(logPath).size;
    if (size > offset) {
      const fd = openSync(logPath, 'r'); const buf = Buffer.alloc(size - offset); readSync(fd, buf, 0, buf.length, offset); offset = size;
      const text = carry + buf.toString('utf8'); const lines = text.split('\n'); carry = lines.pop() ?? '';
      for (const line of lines) write(`W ${stamp} ${line}`);
    }
  }
}
setInterval(tick, 200);
